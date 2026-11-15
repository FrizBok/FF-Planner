// Datenbank der Terminplanung (eingebautes SQLite von Node.js ≥ 22.13, keine Fremdpakete)
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number);
if (NODE_MAJOR < 22 || (NODE_MAJOR === 22 && NODE_MINOR < 13)) {
  console.error(`\n  FF-Planner benötigt Node.js 22.13 oder neuer (gefunden: ${process.version}).\n  Download: https://nodejs.org\n`);
  process.exit(1);
}
const { DatabaseSync } = await import('node:sqlite');
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
process.umask(0o077); // Datenbank & Co. nur für den Server-Benutzer lesbar
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

export const db = new DatabaseSync(path.join(DATA_DIR, 'planner.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
-- Personen aus dem Portal (sub = Benutzer-ID im Portal). Kommen über die Anmeldung und die Mitgliederliste.
CREATE TABLE IF NOT EXISTS people (
  sub TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member',        -- Rolle im Modul: member | planner | admin
  kind TEXT NOT NULL DEFAULT 'member',        -- member | guest
  platform_admin INTEGER NOT NULL DEFAULT 0,
  modules TEXT NOT NULL DEFAULT '{}',         -- Rollen in anderen Modulen (aus der Mitgliederliste), z. B. {"rundown":"editor"}
  active INTEGER NOT NULL DEFAULT 1,          -- 0 = nicht mehr in der Mitgliederliste (Zugriff entzogen)
  last_seen TEXT,
  synced_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                        -- SHA-256 des Cookie-Werts
  sub TEXT NOT NULL REFERENCES people(sub) ON DELETE CASCADE,
  role TEXT NOT NULL,
  expires INTEGER NOT NULL
);
-- Stellen-Liste (Regie, Kamera, Ton …) als Vorlage für Termine
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  date TEXT NOT NULL,                         -- YYYY-MM-DD
  start_time TEXT NOT NULL DEFAULT '',        -- HH:MM
  end_time TEXT NOT NULL DEFAULT '',
  meet_time TEXT NOT NULL DEFAULT '',         -- Treffpunkt/Aufbau
  location TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',       -- draft | open | closed | cancelled
  respond_until TEXT,                         -- YYYY-MM-DD, danach keine Rückmeldung mehr (außer Planer)
  rundown_id INTEGER,
  rundown_title TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
-- Stellen eines Termins (aus der Stellen-Liste oder frei benannt) mit Anzahl
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  position_id INTEGER REFERENCES positions(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  needed INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_slots_event ON slots(event_id, sort);
-- Rückmeldung: kann / vielleicht / kann nicht, mit Kommentar und Wunsch-Stellen
CREATE TABLE IF NOT EXISTS responses (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sub TEXT NOT NULL,
  status TEXT NOT NULL,                       -- yes (vor Ort) | later (später, ab from_time) | online | no
  comment TEXT NOT NULL DEFAULT '',
  wishes TEXT NOT NULL DEFAULT '[]',          -- Slot-IDs, die die Person gern übernehmen würde
  set_by TEXT,                                -- sub, falls ein Planer die Rückmeldung eingetragen hat
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, sub)
);
-- Besetzung: Person auf Stelle
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  sub TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (slot_id, sub)
);
CREATE INDEX IF NOT EXISTS idx_assign_event ON assignments(event_id);
CREATE INDEX IF NOT EXISTS idx_assign_sub ON assignments(sub);
-- Verlauf pro Termin
CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// Ältere Datenbanken: Uhrzeit für „Später“, „Vielleicht“ gibt es nicht mehr (→ „Später“)
if (!db.prepare('PRAGMA table_info(responses)').all().some((c) => c.name === 'from_time')) {
  db.exec("ALTER TABLE responses ADD COLUMN from_time TEXT NOT NULL DEFAULT ''");
}
db.exec("UPDATE responses SET status='later' WHERE status='maybe'");

// Bestätigung der Einteilung, Fähigkeiten pro Person, Kalender-Abo
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!cols('assignments').includes('state')) {
  db.exec("ALTER TABLE assignments ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'"); // pending | confirmed | declined
  db.exec("ALTER TABLE assignments ADD COLUMN note TEXT NOT NULL DEFAULT ''");         // Grund bei „Geht doch nicht“
  db.exec('ALTER TABLE assignments ADD COLUMN answered_at TEXT');
}
if (!cols('people').includes('cal_token')) db.exec('ALTER TABLE people ADD COLUMN cal_token TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS people_skills (
  sub TEXT NOT NULL REFERENCES people(sub) ON DELETE CASCADE,
  position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  PRIMARY KEY (sub, position_id)
)`);

// Stellen-Liste (Vorlage beim Anlegen von Terminen, änderbar unter „Verwaltung → Stellen“).
// Freie Stellen gibt es beim Anlegen zusätzlich über „Andere …“.
export const DEFAULT_POSITIONS = ['Regie', 'Grafik', 'Ton', 'Spec', 'Replay', 'Mod', 'Caster'];
const OLD_DEFAULT = ['Regie', 'Bildmischer', 'Kamera', 'Ton', 'Grafik', 'Kommentar', 'Licht', 'Producer'];
{
  const cur = db.prepare('SELECT * FROM positions ORDER BY sort, id').all();
  const ins = db.prepare('INSERT INTO positions (name, sort) VALUES (?, ?)');
  if (!cur.length) DEFAULT_POSITIONS.forEach((n, i) => ins.run(n, i));
  // Ältere Installationen mit der unveränderten ersten Vorlage einmalig auf die neue Liste umstellen
  // (bestehende Termine behalten ihre Stellen, nur die Vorlage ändert sich)
  else if (cur.length === OLD_DEFAULT.length && cur.every((p, i) => p.name === OLD_DEFAULT[i] && p.active)) {
    db.exec('BEGIN');
    try {
      for (const p of cur) if (!DEFAULT_POSITIONS.includes(p.name)) db.prepare('DELETE FROM positions WHERE id=?').run(p.id);
      DEFAULT_POSITIONS.forEach((n, i) => {
        if (cur.some((p) => p.name === n)) db.prepare('UPDATE positions SET sort=? WHERE name=?').run(i, n);
        else ins.run(n, i);
      });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? null;
export const setSetting = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
