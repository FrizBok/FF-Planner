// Anbindung an das Portal „FrankenFinals Broadcast“.
//
// Die Terminplanung hat keine eigenen Konten. Angemeldet wird über die Kachel im Portal:
//   Portal /sso/planner → <diese Adresse>/auth/portal?ticket=…[&next=/#/termin/5]
// Das Ticket ist mit PORTAL_SSO_SECRET (im Portal: PLANNER_SSO_SECRET) per HMAC-SHA256 signiert, 60 s gültig und
// nur einmal nutzbar. Es enthält sub, email, name, role (member|planner|admin), kind (member|guest), platform_admin.
//
// Mit demselben Schlüssel holt sich die Terminplanung die Liste aller Personen mit Zugriff
// (GET <PORTAL_URL>/api/modules/planner/directory) – so können Planer auch Leute einteilen,
// die das Modul noch nie geöffnet haben.
import crypto from 'node:crypto';
import { db, setSetting, getSetting } from './db.js';

export function normalizeBaseUrl(raw) {
  let v = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
  try { return new URL(v).origin; } catch { return ''; }
}

export const ROLES = ['member', 'planner', 'admin'];
export const rank = (r) => ROLES.indexOf(r);

export const PORTAL = {
  url: normalizeBaseUrl(process.env.PORTAL_URL),
  secret: String(process.env.PORTAL_SSO_SECRET || '').trim(),
  moduleId: String(process.env.PORTAL_MODULE_ID || 'planner').trim(),
  hours: Math.max(1, Math.min(Number(process.env.PORTAL_SESSION_HOURS) || 12, 24 * 7)),
};
export const portalEnabled = () => PORTAL.secret.length >= 32;
/** Anmelde-Link im Portal, optional mit Ziel in der Terminplanung */
export const loginUrl = (next = '') => (PORTAL.url ? `${PORTAL.url}/sso/${PORTAL.moduleId}${next ? '?next=' + encodeURIComponent(next) : ''}` : null);

export function verifyTicket(ticket, secret = PORTAL.secret, aud = PORTAL.moduleId, now = Date.now()) {
  const [body, sig] = String(ticket || '').split('.');
  if (!body || !sig || secret.length < 32) return null;
  const want = crypto.createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (p.v !== 1 || p.aud !== aud || typeof p.exp !== 'number' || p.exp * 1000 < now || !p.jti || !p.sub || !p.email) return null;
  return p;
}

const used = new Map();
/** Jede Eintrittskarte gilt nur einmal */
export function firstUse(jti, expMs) {
  const now = Date.now();
  for (const [k, until] of used) if (until < now) used.delete(k);
  if (used.has(jti)) return false;
  used.set(jti, expMs);
  return true;
}

/** Ziel nach der Anmeldung: nur Seiten dieser App */
export function safeNext(raw) {
  const v = String(raw || '');
  return v.length <= 300 && /^\/(?![/\\])[^\s]*$/.test(v) ? v : '';
}

const upsert = db.prepare(`INSERT INTO people (sub, email, name, role, kind, platform_admin, active, last_seen)
  VALUES (?,?,?,?,?,?,1,datetime('now'))
  ON CONFLICT(sub) DO UPDATE SET email=excluded.email, name=excluded.name, role=excluded.role, kind=excluded.kind,
    platform_admin=excluded.platform_admin, active=1, last_seen=datetime('now')`);

/** Person aus der Eintrittskarte anlegen/aktualisieren */
export function upsertFromTicket(t) {
  if (!ROLES.includes(t.role)) throw new Error('Unbekannte Rolle aus dem Portal');
  upsert.run(String(t.sub), String(t.email).trim(), String(t.name || '').trim(), t.role, t.kind === 'guest' ? 'guest' : 'member', t.platform_admin ? 1 : 0);
  return db.prepare('SELECT * FROM people WHERE sub=?').get(String(t.sub));
}

/* ------------------------------------------------------------------ Mitgliederliste */
export const directoryEnabled = () => portalEnabled() && !!PORTAL.url;
export function signDirectory(secret = PORTAL.secret, id = PORTAL.moduleId, ts = Math.floor(Date.now() / 1000)) {
  return `${ts}.${crypto.createHmac('sha256', secret).update(`directory:${id}:${ts}`).digest('base64url')}`;
}

let syncing = null;
/** Mitgliederliste aus dem Portal holen und übernehmen. Wer fehlt, wird inaktiv (Einteilungen bleiben erhalten). */
export function syncDirectory({ fetchImpl = fetch } = {}) {
  if (!directoryEnabled()) return Promise.resolve({ ok: false, error: 'Portal nicht eingerichtet (PORTAL_URL / PORTAL_SSO_SECRET)' });
  syncing ||= (async () => {
    try {
      const r = await fetchImpl(`${PORTAL.url}/api/modules/${PORTAL.moduleId}/directory`, {
        headers: { Authorization: 'Portal ' + signDirectory() }, signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(r.status === 401 ? 'Portal lehnt die Anfrage ab – stimmt der Schlüssel?' : `Portal antwortet mit ${r.status}`);
      const data = await r.json();
      const users = Array.isArray(data.users) ? data.users : [];
      const seen = new Set();
      db.exec('BEGIN');
      try {
        const setMods = db.prepare("UPDATE people SET modules=?, synced_at=datetime('now') WHERE sub=?");
        for (const u of users) {
          if (!u?.sub || !u.email || !ROLES.includes(u.role)) continue;
          db.prepare(`INSERT INTO people (sub, email, name, role, kind, platform_admin, active) VALUES (?,?,?,?,?,?,1)
            ON CONFLICT(sub) DO UPDATE SET email=excluded.email, name=excluded.name, role=excluded.role, kind=excluded.kind,
              platform_admin=excluded.platform_admin, active=1`)
            .run(String(u.sub), String(u.email), String(u.name || ''), u.role, u.kind === 'guest' ? 'guest' : 'member', u.platform_admin ? 1 : 0);
          setMods.run(JSON.stringify(u.modules || {}), String(u.sub));
          seen.add(String(u.sub));
        }
        for (const p of db.prepare('SELECT sub FROM people WHERE active=1').all()) {
          if (!seen.has(p.sub)) {
            db.prepare('UPDATE people SET active=0 WHERE sub=?').run(p.sub);
            db.prepare('DELETE FROM sessions WHERE sub=?').run(p.sub); // Zugriff entzogen → abmelden
          }
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      const res = { ok: true, at: Date.now(), count: seen.size };
      setSetting('directory_status', JSON.stringify(res));
      return res;
    } catch (e) {
      const res = { ok: false, at: Date.now(), error: e.name === 'TimeoutError' ? 'Portal nicht erreichbar (Zeitüberschreitung)' : e.message };
      setSetting('directory_status', JSON.stringify(res));
      return res;
    } finally { syncing = null; }
  })();
  return syncing;
}
export const directoryStatus = () => { try { return JSON.parse(getSetting('directory_status') || 'null'); } catch { return null; } };
