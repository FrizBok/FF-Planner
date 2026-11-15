// FF-Planner – Terminplanung als Modul des Portals „FrankenFinals Broadcast“ (ohne Fremdpakete: nur Node.js ≥ 22.13)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, tx, sha256, randomToken, DATA_DIR } from './db.js';
import * as portal from './portal.js';
import * as rd from './rundown.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const COOKIE = 'ffpl_session';
const SYNC_MINUTES = Math.max(2, Number(process.env.DIRECTORY_SYNC_MINUTES) || 10);

/* ================================================================== Helfer */
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const HANDLED = Symbol('handled');

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...headers });
  res.end(JSON.stringify(data));
}
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Anfrage zu groß')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Ungültiges JSON')); }
    });
    req.on('error', reject);
  });
}
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isSecure = (req) => {
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === 'false') return false;
  return TRUST_PROXY ? req.headers['x-forwarded-proto'] === 'https' : !!req.socket.encrypted;
};
const cookie = (req, value, maxAge) => `${COOKIE}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; HttpOnly; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`;
const reqHost = (req) => (TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host || '';
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: process.env.TZ || 'Europe/Berlin' }); // YYYY-MM-DD
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const json = (v, d) => { try { return JSON.parse(v); } catch { return d; } };

/* ================================================================== Router */
const routes = [];
function route(method, p, ...handlers) {
  const keys = [];
  const re = new RegExp('^' + p.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handlers });
}
const GET = (p, ...h) => route('GET', p, ...h);
const POST = (p, ...h) => route('POST', p, ...h);
const PUT = (p, ...h) => route('PUT', p, ...h);
const PATCH = (p, ...h) => route('PATCH', p, ...h);
const DELETE = (p, ...h) => route('DELETE', p, ...h);

/* ================================================================== Sitzungen & Rechte */
function sessionUser(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(sha256(raw));
  if (!s || s.expires < Date.now()) return null;
  const p = db.prepare('SELECT * FROM people WHERE sub=? AND active=1').get(s.sub);
  return p || null;
}
const isPlanner = (u) => !!u && portal.rank(u.role) >= portal.rank('planner');
const isAdmin = (u) => !!u && u.role === 'admin';
const isGuest = (u) => !!u && u.kind === 'guest' && !isPlanner(u);
const hasRundown = (u) => {
  if (!rd.rundownLinked()) return false;
  const mods = json(u.modules, {});
  return !u.synced_at || !!mods.rundown; // ohne Mitgliederliste: Link zeigen, FF Rundown prüft selbst
};
const needAuth = (req) => { if (!req.user) fail(401, 'Bitte über das Portal anmelden'); };
const needPlanner = (req) => { needAuth(req); if (!isPlanner(req.user)) fail(403, 'Dafür sind Planer-Rechte nötig'); };
const needAdmin = (req) => { needAuth(req); if (!isAdmin(req.user)) fail(403, 'Dafür sind Planer-Admin-Rechte nötig'); };

const meOut = (u) => ({
  sub: u.sub, email: u.email, name: u.name, role: u.role, kind: u.kind, platform_admin: !!u.platform_admin,
  can_plan: isPlanner(u), is_admin: isAdmin(u), has_rundown: hasRundown(u),
});
const personOut = (p) => p ? { sub: p.sub, name: p.name || p.email.split('@')[0], email: p.email, kind: p.kind, active: !!p.active } : null;
const personBySub = (sub) => db.prepare('SELECT * FROM people WHERE sub=?').get(String(sub));

/* ================================================================== Anmeldung über das Portal */
function infoPage(res, status, title, text, { login = true } = {}) {
  const href = portal.loginUrl();
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS });
  res.end(`<!doctype html><html lang="de" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Terminplanung</title>
<link rel="stylesheet" href="/css/fonts.css"><link rel="stylesheet" href="/css/portal.css"></head><body><div class="auth-wrap"><div class="auth-card">
<h1>${esc(title)}</h1><p>${esc(text)}</p>${login && href ? `<a class="btn primary" href="${esc(href)}">Über das Portal öffnen</a>` : ''}</div></div></body></html>`);
}

function portalLogin(req, res, url) {
  if (!portal.portalEnabled()) return infoPage(res, 503, 'Nicht eingerichtet', 'Die Anmeldung über das Portal ist nicht eingerichtet (PORTAL_SSO_SECRET fehlt).', { login: false });
  const t = portal.verifyTicket(url.searchParams.get('ticket'));
  if (!t) return infoPage(res, 401, 'Anmeldung abgelaufen', 'Der Link aus dem Portal ist ungültig oder abgelaufen. Öffne die Terminplanung bitte erneut über die Kachel im Portal.');
  if (!portal.firstUse(t.jti, t.exp * 1000)) return infoPage(res, 401, 'Link schon benutzt', 'Dieser Anmelde-Link wurde bereits verwendet. Öffne die Terminplanung bitte erneut über die Kachel im Portal.');
  let p;
  try { p = portal.upsertFromTicket(t); } catch (e) { return infoPage(res, 403, 'Kein Zugriff', e.message); }
  const raw = randomToken(32);
  const ttl = portal.PORTAL.hours * 3600;
  db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  db.prepare('INSERT INTO sessions (id, sub, role, expires) VALUES (?,?,?,?)').run(sha256(raw), p.sub, p.role, Date.now() + ttl * 1000);
  res.writeHead(302, { Location: portal.safeNext(url.searchParams.get('next')) || '/', 'Set-Cookie': cookie(req, raw, ttl), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end();
}

GET('/api/health', () => ({ ok: true, version: VERSION }));
GET('/api/status', (req) => ({
  version: VERSION,
  user: req.user ? meOut(req.user) : null,
  portal: { url: portal.PORTAL.url || null, login: portal.loginUrl(), enabled: portal.portalEnabled() },
  rundown: { linked: rd.rundownLinked(), api: rd.rundownApi() },
}));
POST('/api/logout', (req, res) => {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (raw) db.prepare('DELETE FROM sessions WHERE id=?').run(sha256(raw));
  res.setHeader('Set-Cookie', cookie(req, '', 0));
  return { ok: true, portal: portal.PORTAL.url || null };
});

/* ================================================================== Termine */
const STATUS = ['draft', 'open', 'closed', 'cancelled'];
const RESP = ['yes', 'maybe', 'no'];
const logEvent = (eventId, actor, action, detail = '') => db.prepare('INSERT INTO event_log (event_id, at, actor, action, detail) VALUES (?,?,?,?,?)').run(eventId, Date.now(), actor?.sub || null, action, String(detail).slice(0, 300));

function getEvent(id) {
  const e = db.prepare('SELECT * FROM events WHERE id=?').get(Number(id));
  if (!e) fail(404, 'Termin nicht gefunden');
  return e;
}
const assignedSubs = (eventId) => new Set(db.prepare('SELECT sub FROM assignments WHERE event_id=?').all(eventId).map((a) => a.sub));
/** Darf die Person den Termin sehen? Entwürfe nur Planer, Gäste nur Termine, für die sie eingeteilt sind. */
function canSee(u, e) {
  if (isPlanner(u)) return true;
  if (e.status === 'draft') return false;
  if (isGuest(u)) return assignedSubs(e.id).has(u.sub);
  return true;
}
const seeEvent = (req) => { const e = getEvent(req.params.id); if (!canSee(req.user, e)) fail(404, 'Termin nicht gefunden'); req.event = e; };
/** Rückmeldung möglich? (Planer immer, sonst nur bei offener Abfrage und vor der Frist) */
function respondOpen(e) {
  if (e.status !== 'open') return false;
  if (e.respond_until && e.respond_until < today()) return false;
  return true;
}

function slotsOf(eventId) {
  const slots = db.prepare('SELECT * FROM slots WHERE event_id=? ORDER BY sort, id').all(eventId);
  const asg = db.prepare('SELECT a.*, p.name, p.email, p.kind, p.active FROM assignments a LEFT JOIN people p ON p.sub=a.sub WHERE a.event_id=? ORDER BY a.id').all(eventId);
  return slots.map((s) => {
    const people = asg.filter((a) => a.slot_id === s.id).map((a) => ({ id: a.id, ...personOut({ sub: a.sub, name: a.name, email: a.email || '?', kind: a.kind, active: a.active ?? 0 }) }));
    return { id: s.id, name: s.name, position_id: s.position_id, needed: s.needed, assigned: people, open: Math.max(0, s.needed - people.length) };
  });
}

function rundownOut(e, u) {
  if (!e.rundown_id || !rd.rundownLinked()) return null;
  return { id: e.rundown_id, title: e.rundown_title || `Rundown #${e.rundown_id}`, link: hasRundown(u) || isPlanner(u) ? rd.rundownLink(e.rundown_id) : null };
}

function summary(e, u) {
  const counts = { yes: 0, maybe: 0, no: 0 };
  for (const r of db.prepare('SELECT status FROM responses WHERE event_id=?').all(e.id)) counts[r.status] = (counts[r.status] || 0) + 1;
  const slots = slotsOf(e.id);
  const mine = db.prepare('SELECT * FROM responses WHERE event_id=? AND sub=?').get(e.id, u.sub);
  return {
    id: e.id, title: e.title, date: e.date, start_time: e.start_time, end_time: e.end_time, meet_time: e.meet_time, location: e.location,
    status: e.status, respond_until: e.respond_until, respond_open: respondOpen(e),
    counts, needed: slots.reduce((n, s) => n + s.needed, 0), filled: slots.reduce((n, s) => n + Math.min(s.needed, s.assigned.length), 0),
    open: slots.reduce((n, s) => n + s.open, 0),
    open_slots: slots.filter((s) => s.open > 0).map((s) => ({ id: s.id, name: s.name, open: s.open })),
    my_response: mine ? { status: mine.status, comment: mine.comment, wishes: json(mine.wishes, []) } : null,
    my_slots: slots.filter((s) => s.assigned.some((a) => a.sub === u.sub)).map((s) => s.name),
    rundown: rundownOut(e, u),
  };
}

GET('/api/events', needAuth, (req) => {
  const scope = ['upcoming', 'past', 'open', 'mine', 'all'].includes(req.query.scope) ? req.query.scope : 'upcoming';
  const d = today();
  let rows = scope === 'past'
    ? db.prepare('SELECT * FROM events WHERE date<? ORDER BY date DESC, start_time DESC LIMIT 200').all(d)
    : scope === 'all' ? db.prepare('SELECT * FROM events ORDER BY date, start_time').all()
      : db.prepare('SELECT * FROM events WHERE date>=? ORDER BY date, start_time').all(d);
  rows = rows.filter((e) => canSee(req.user, e));
  let out = rows.map((e) => summary(e, req.user));
  if (scope === 'open') out = out.filter((e) => e.open > 0 && e.status !== 'cancelled' && e.status !== 'draft');
  if (scope === 'mine') out = out.filter((e) => e.my_slots.length && e.status !== 'cancelled');
  return { today: d, events: out };
});

function eventFields(b, partial = false) {
  const f = {};
  if (!partial || b.title !== undefined) { f.title = str(b.title, 120); if (!f.title) fail(400, 'Bitte einen Titel angeben'); }
  if (!partial || b.date !== undefined) { f.date = str(b.date, 10); if (!DATE_RE.test(f.date)) fail(400, 'Bitte ein gültiges Datum angeben'); }
  for (const k of ['start_time', 'end_time', 'meet_time']) {
    if (partial && b[k] === undefined) continue;
    f[k] = str(b[k], 5);
    if (f[k] && !TIME_RE.test(f[k])) fail(400, 'Ungültige Uhrzeit (HH:MM)');
  }
  if (!partial || b.location !== undefined) f.location = str(b.location, 200);
  if (!partial || b.description !== undefined) f.description = str(b.description, 4000);
  if (!partial || b.respond_until !== undefined) {
    f.respond_until = str(b.respond_until, 10) || null;
    if (f.respond_until && !DATE_RE.test(f.respond_until)) fail(400, 'Ungültige Rückmeldefrist');
  }
  if (b.status !== undefined) { if (!STATUS.includes(b.status)) fail(400, 'Ungültiger Status'); f.status = b.status; }
  return f;
}

/** Stellen eines Termins setzen: [{ id?, name?, position_id?, needed }] – fehlende werden entfernt (samt Einteilungen) */
function saveSlots(eventId, list) {
  if (!Array.isArray(list)) fail(400, 'Ungültige Stellen');
  if (list.length > 60) fail(400, 'Zu viele Stellen');
  const existing = new Map(db.prepare('SELECT * FROM slots WHERE event_id=?').all(eventId).map((s) => [s.id, s]));
  const keep = new Set();
  list.forEach((s, i) => {
    const pos = s.position_id ? db.prepare('SELECT * FROM positions WHERE id=?').get(Number(s.position_id)) : null;
    const name = str(s.name, 60) || pos?.name;
    if (!name) fail(400, 'Jede Stelle braucht einen Namen');
    const needed = Math.max(1, Math.min(50, parseInt(s.needed, 10) || 1));
    const old = s.id ? existing.get(Number(s.id)) : null;
    if (old) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE slot_id=?').get(old.id).n;
      if (n > needed) fail(400, `„${name}“: ${n} Personen eingeteilt – erst Personen entfernen, dann die Anzahl verringern`);
      db.prepare('UPDATE slots SET name=?, position_id=?, needed=?, sort=? WHERE id=?').run(name, pos?.id ?? null, needed, i, old.id);
      keep.add(old.id);
    } else {
      db.prepare('INSERT INTO slots (event_id, position_id, name, needed, sort) VALUES (?,?,?,?,?)').run(eventId, pos?.id ?? null, name, needed, i);
    }
  });
  for (const id of existing.keys()) if (!keep.has(id)) db.prepare('DELETE FROM slots WHERE id=?').run(id);
}

POST('/api/events', needPlanner, (req) => {
  const f = eventFields(req.body);
  f.status ||= 'draft';
  const id = tx(() => {
    const r = db.prepare(`INSERT INTO events (title, date, start_time, end_time, meet_time, location, description, status, respond_until, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(f.title, f.date, f.start_time, f.end_time, f.meet_time, f.location, f.description, f.status, f.respond_until, req.user.sub);
    const eid = Number(r.lastInsertRowid);
    if (req.body.slots) saveSlots(eid, req.body.slots);
    logEvent(eid, req.user, 'created', f.title);
    return eid;
  });
  return { id };
});

function detail(e, u) {
  const planner = isPlanner(u);
  const slots = slotsOf(e.id);
  const responses = db.prepare('SELECT r.*, p.name, p.email, p.kind, p.active FROM responses r LEFT JOIN people p ON p.sub=r.sub WHERE r.event_id=? ORDER BY r.updated_at').all(e.id)
    .map((r) => ({ ...personOut({ sub: r.sub, name: r.name, email: r.email || '?', kind: r.kind, active: r.active ?? 0 }), status: r.status, comment: r.comment, wishes: json(r.wishes, []), by_planner: !!r.set_by && r.set_by !== r.sub, updated_at: r.updated_at }));
  const out = { ...summary(e, u), description: e.description, slots, responses, can_plan: planner };
  if (planner) {
    // Alle aktiven Personen mit Zugriff (für die Einteilung, Gäste eingeschlossen)
    const resp = new Map(responses.map((r) => [r.sub, r]));
    out.people = db.prepare('SELECT * FROM people WHERE active=1 ORDER BY lower(name), lower(email)').all()
      .map((p) => ({ ...personOut(p), response: resp.get(p.sub)?.status || null }));
    out.no_answer = out.people.filter((p) => !p.response && p.kind !== 'guest').map((p) => ({ sub: p.sub, name: p.name }));
    out.log = db.prepare('SELECT l.*, p.name, p.email FROM event_log l LEFT JOIN people p ON p.sub=l.actor WHERE l.event_id=? ORDER BY l.id DESC LIMIT 50').all(e.id)
      .map((l) => ({ at: l.at, action: l.action, detail: l.detail, by: l.name || l.email || null }));
  }
  return out;
}

GET('/api/events/:id', needAuth, seeEvent, (req) => detail(req.event, req.user));

PATCH('/api/events/:id', needPlanner, (req) => {
  const e = getEvent(req.params.id);
  const f = eventFields(req.body, true);
  tx(() => {
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE events SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=datetime('now') WHERE id=?`).run(...keys.map((k) => f[k]), e.id);
    if (req.body.slots) saveSlots(e.id, req.body.slots);
    if (f.status && f.status !== e.status) logEvent(e.id, req.user, 'status', f.status);
    else if (keys.length || req.body.slots) logEvent(e.id, req.user, 'edited', [...keys, req.body.slots ? 'slots' : ''].filter(Boolean).join(', '));
  });
  return detail(getEvent(e.id), req.user);
});

POST('/api/events/:id/duplicate', needPlanner, (req) => {
  const e = getEvent(req.params.id);
  const date = str(req.body.date, 10) || e.date;
  if (!DATE_RE.test(date)) fail(400, 'Ungültiges Datum');
  const id = tx(() => {
    const r = db.prepare(`INSERT INTO events (title, date, start_time, end_time, meet_time, location, description, status, created_by)
      VALUES (?,?,?,?,?,?,?,'draft',?)`).run(str(req.body.title, 120) || e.title, date, e.start_time, e.end_time, e.meet_time, e.location, e.description, req.user.sub);
    const nid = Number(r.lastInsertRowid);
    for (const s of db.prepare('SELECT * FROM slots WHERE event_id=? ORDER BY sort, id').all(e.id)) {
      db.prepare('INSERT INTO slots (event_id, position_id, name, needed, sort) VALUES (?,?,?,?,?)').run(nid, s.position_id, s.name, s.needed, s.sort);
    }
    logEvent(nid, req.user, 'created', `Kopie von „${e.title}“`);
    return nid;
  });
  return { id };
});

DELETE('/api/events/:id', needPlanner, (req) => {
  const e = getEvent(req.params.id);
  if (!isAdmin(req.user) && e.status !== 'draft') fail(403, 'Freigegebene Termine kann nur ein Planer-Admin löschen – sonst bitte „Absagen“');
  db.prepare('DELETE FROM events WHERE id=?').run(e.id);
  return { ok: true };
});

/* ---------- Rückmeldungen */
PUT('/api/events/:id/response', needAuth, seeEvent, (req) => {
  const e = req.event;
  const planner = isPlanner(req.user);
  const sub = req.body.sub && req.body.sub !== req.user.sub ? String(req.body.sub) : req.user.sub;
  if (sub !== req.user.sub && !planner) fail(403, 'Nur Planer können für andere eintragen');
  if (!personBySub(sub)) fail(404, 'Person nicht gefunden');
  if (!planner && !respondOpen(e)) fail(400, e.status === 'open' ? 'Die Rückmeldefrist ist abgelaufen' : 'Für diesen Termin sind keine Rückmeldungen (mehr) möglich');
  if (req.body.status === null) {
    db.prepare('DELETE FROM responses WHERE event_id=? AND sub=?').run(e.id, sub);
    return detail(e, req.user);
  }
  if (!RESP.includes(req.body.status)) fail(400, 'Ungültige Rückmeldung');
  const slotIds = new Set(db.prepare('SELECT id FROM slots WHERE event_id=?').all(e.id).map((s) => s.id));
  const wishes = req.body.status === 'no' ? [] : (Array.isArray(req.body.wishes) ? req.body.wishes : []).map(Number).filter((id) => slotIds.has(id)).slice(0, 20);
  const old = db.prepare('SELECT * FROM responses WHERE event_id=? AND sub=?').get(e.id, sub);
  db.prepare(`INSERT INTO responses (event_id, sub, status, comment, wishes, set_by, updated_at) VALUES (?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(event_id, sub) DO UPDATE SET status=excluded.status, comment=excluded.comment, wishes=excluded.wishes, set_by=excluded.set_by, updated_at=datetime('now')`)
    .run(e.id, sub, req.body.status, str(req.body.comment ?? old?.comment ?? '', 300), JSON.stringify([...new Set(wishes)]), req.user.sub);
  if (sub !== req.user.sub) logEvent(e.id, req.user, 'response_for', `${personBySub(sub).name || personBySub(sub).email}: ${req.body.status}`);
  return detail(e, req.user);
});

/* ---------- Besetzung */
POST('/api/events/:id/assign', needPlanner, (req) => {
  const e = getEvent(req.params.id);
  const slot = db.prepare('SELECT * FROM slots WHERE id=? AND event_id=?').get(Number(req.body.slot_id), e.id);
  if (!slot) fail(404, 'Stelle nicht gefunden');
  const p = personBySub(req.body.sub);
  if (!p || !p.active) fail(404, 'Person nicht gefunden oder ohne Zugriff');
  if (db.prepare('SELECT 1 FROM assignments WHERE slot_id=? AND sub=?').get(slot.id, p.sub)) fail(400, `${p.name || p.email} ist schon als ${slot.name} eingeteilt`);
  const n = db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE slot_id=?').get(slot.id).n;
  if (n >= slot.needed) fail(400, `${slot.name} ist schon voll besetzt – erst die Anzahl erhöhen`);
  db.prepare('INSERT INTO assignments (event_id, slot_id, sub, created_by) VALUES (?,?,?,?)').run(e.id, slot.id, p.sub, req.user.sub);
  logEvent(e.id, req.user, 'assigned', `${p.name || p.email} → ${slot.name}`);
  return detail(getEvent(e.id), req.user);
});
DELETE('/api/events/:id/assign/:aid', needPlanner, (req) => {
  const e = getEvent(req.params.id);
  const a = db.prepare('SELECT a.*, s.name AS slot, p.name, p.email FROM assignments a JOIN slots s ON s.id=a.slot_id LEFT JOIN people p ON p.sub=a.sub WHERE a.id=? AND a.event_id=?').get(Number(req.params.aid), e.id);
  if (!a) fail(404, 'Einteilung nicht gefunden');
  db.prepare('DELETE FROM assignments WHERE id=?').run(a.id);
  logEvent(e.id, req.user, 'unassigned', `${a.name || a.email || a.sub} ✕ ${a.slot}`);
  return detail(getEvent(e.id), req.user);
});

/* ---------- Rundown hinterlegen */
GET('/api/events/:id/rundowns', needPlanner, async (req) => {
  getEvent(req.params.id);
  const r = await rdCall(() => rd.listFor(req.user.email));
  return { user: r.user, rundowns: r.rundowns };
});
PUT('/api/events/:id/rundown', needPlanner, async (req) => {
  const e = getEvent(req.params.id);
  const r = await rdCall(() => rd.getFor(req.body.rundown_id, req.user.email));
  if (!r.my_role) fail(403, 'Diesen Rundown darfst du in FF Rundown nicht sehen');
  db.prepare("UPDATE events SET rundown_id=?, rundown_title=?, updated_at=datetime('now') WHERE id=?").run(r.id, r.title, e.id);
  logEvent(e.id, req.user, 'rundown', r.title);
  return detail(getEvent(e.id), req.user);
});
POST('/api/events/:id/rundown', needPlanner, async (req) => {
  const e = getEvent(req.params.id);
  const r = await rdCall(() => rd.createFor(req.user.email, { title: str(req.body.title, 200) || e.title, event_date: e.date, start_time: e.start_time || undefined }));
  db.prepare("UPDATE events SET rundown_id=?, rundown_title=?, updated_at=datetime('now') WHERE id=?").run(r.id, r.title, e.id);
  logEvent(e.id, req.user, 'rundown', `${r.title} (neu)`);
  return detail(getEvent(e.id), req.user);
});
DELETE('/api/events/:id/rundown', needPlanner, (req) => {
  const e = getEvent(req.params.id);
  db.prepare("UPDATE events SET rundown_id=NULL, rundown_title=NULL, updated_at=datetime('now') WHERE id=?").run(e.id);
  logEvent(e.id, req.user, 'rundown', 'entfernt');
  return detail(getEvent(e.id), req.user);
});
async function rdCall(fn) {
  try { return await fn(); } catch (e) { fail(e.status || 502, e.message); }
}

/* ---------- Kalender-Datei (.ics) */
GET('/api/events/:id/ics', needAuth, seeEvent, (req, res) => {
  const e = req.event;
  const dt = (d, t) => d.replace(/-/g, '') + (t ? 'T' + t.replace(':', '') + '00' : '');
  const icsEsc = (v) => String(v || '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\r?\n/g, '\\n');
  const mine = slotsOf(e.id).filter((s) => s.assigned.some((a) => a.sub === req.user.sub)).map((s) => s.name);
  const end = e.end_time;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FrankenFinals Broadcast//Terminplanung//DE', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:planner-${e.id}@${reqHost(req) || 'ff-planner'}`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    e.start_time ? `DTSTART;TZID=Europe/Berlin:${dt(e.date, e.meet_time || e.start_time)}` : `DTSTART;VALUE=DATE:${dt(e.date)}`,
    e.start_time && end ? `DTEND;TZID=Europe/Berlin:${dt(e.end_time < (e.meet_time || e.start_time) ? nextDay(e.date) : e.date, end)}` : null,
    `SUMMARY:${icsEsc(e.title + (mine.length ? ` (${mine.join(', ')})` : ''))}`,
    e.location ? `LOCATION:${icsEsc(e.location)}` : null,
    `DESCRIPTION:${icsEsc([e.meet_time ? `Treffen: ${e.meet_time}` : '', e.start_time ? `Beginn: ${e.start_time}` : '', mine.length ? `Deine Stelle: ${mine.join(', ')}` : '', e.description].filter(Boolean).join('\n'))}`,
    e.status === 'cancelled' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'END:VEVENT', 'END:VCALENDAR'].filter(Boolean);
  res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="termin-${e.id}.ics"`, 'Cache-Control': 'no-store', ...SEC_HEADERS });
  res.end(lines.join('\r\n') + '\r\n');
  return HANDLED;
});
const nextDay = (d) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };

/* ================================================================== Stellen-Liste */
GET('/api/positions', needAuth, () => ({ positions: db.prepare('SELECT * FROM positions ORDER BY sort, id').all().map((p) => ({ ...p, active: !!p.active })) }));
POST('/api/positions', needAdmin, (req) => {
  const name = str(req.body.name, 60);
  if (!name) fail(400, 'Bitte einen Namen angeben');
  if (db.prepare('SELECT 1 FROM positions WHERE name=?').get(name)) fail(400, 'Diese Stelle gibt es schon');
  const sort = (db.prepare('SELECT MAX(sort) AS m FROM positions').get().m ?? -1) + 1;
  db.prepare('INSERT INTO positions (name, sort) VALUES (?,?)').run(name, sort);
  return { ok: true };
});
PATCH('/api/positions/:id', needAdmin, (req) => {
  const p = db.prepare('SELECT * FROM positions WHERE id=?').get(Number(req.params.id));
  if (!p) fail(404, 'Stelle nicht gefunden');
  const name = req.body.name !== undefined ? str(req.body.name, 60) : p.name;
  if (!name) fail(400, 'Bitte einen Namen angeben');
  if (db.prepare('SELECT 1 FROM positions WHERE name=? AND id<>?').get(name, p.id)) fail(400, 'Diese Stelle gibt es schon');
  db.prepare('UPDATE positions SET name=?, active=? WHERE id=?').run(name, req.body.active === undefined ? p.active : (req.body.active ? 1 : 0), p.id);
  return { ok: true };
});
POST('/api/positions/order', needAdmin, (req) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  tx(() => ids.forEach((id, i) => db.prepare('UPDATE positions SET sort=? WHERE id=?').run(i, id)));
  return { ok: true };
});
DELETE('/api/positions/:id', needAdmin, (req) => {
  // Termine behalten den Namen der Stelle (position_id wird leer)
  db.prepare('DELETE FROM positions WHERE id=?').run(Number(req.params.id));
  return { ok: true };
});

/* ================================================================== Personen */
GET('/api/people', needPlanner, () => ({
  sync: { enabled: portal.directoryEnabled(), status: portal.directoryStatus(), minutes: SYNC_MINUTES },
  people: db.prepare('SELECT * FROM people ORDER BY active DESC, lower(name), lower(email)').all()
    .map((p) => ({ ...personOut(p), role: p.role, last_seen: p.last_seen, has_rundown: !!json(p.modules, {}).rundown })),
}));
POST('/api/people/sync', needPlanner, async () => {
  const r = await portal.syncDirectory();
  if (!r.ok) fail(502, r.error);
  return r;
});

/* ================================================================== Statische Dateien */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
function serveFile(req, res, file) {
  const st = fs.statSync(file);
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const ext = path.extname(file).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.woff2' ? 'public, max-age=604800' : 'no-cache', ETag: etag, ...SEC_HEADERS };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}
function tryStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return false; }
  if (rel.includes('\0')) return false;
  const file = path.normalize(path.join(PUBLIC, rel === '/' ? 'index.html' : rel));
  if (!file.startsWith(PUBLIC + path.sep)) return false;
  try { if (fs.statSync(file).isFile()) { serveFile(req, res, file); return true; } } catch { /* */ }
  if (!path.extname(rel)) { serveFile(req, res, path.join(PUBLIC, 'index.html')); return true; }
  return false;
}

/* ================================================================== Server */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Nicht erlaubt' });
      if (pathname === '/auth/portal') return portalLogin(req, res, url);
      if (tryStatic(req, res, pathname)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SEC_HEADERS });
      return res.end('Nicht gefunden');
    }
    // Anfragen aus fremden Seiten verhindern (CSRF) – zusätzlich zu SameSite=Lax
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
      let ok = false;
      try { ok = new URL(req.headers.origin).host === reqHost(req); } catch { /* */ }
      if (!ok) return send(res, 403, { error: 'Ungültiger Ursprung der Anfrage' });
    }
    req.user = sessionUser(req);
    req.query = Object.fromEntries(url.searchParams);
    let matched = false;
    for (const r of routes) {
      const m = pathname.match(r.re);
      if (!m) continue;
      matched = true;
      if (r.method !== req.method) continue;
      req.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      req.body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      for (let i = 0; i < r.handlers.length; i++) {
        const out = await r.handlers[i](req, res);
        if (out === HANDLED) return;
        if (i === r.handlers.length - 1) return send(res, 200, out ?? { ok: true });
      }
      return;
    }
    send(res, matched ? 405 : 404, { error: matched ? 'Methode nicht erlaubt' : 'Nicht gefunden' });
  } catch (e) {
    if (e instanceof HttpError) { if (!res.headersSent) send(res, e.status, { error: e.message }); return; }
    console.error('  Serverfehler:', e);
    if (!res.headersSent) send(res, 500, { error: 'Interner Serverfehler' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  FF-Planner (Terminplanung) v${VERSION} läuft`);
  console.log(`  Lokal:     http://localhost:${PORT}`);
  console.log(`  Daten:     ${DATA_DIR}`);
  console.log(`  Portal:    ${portal.portalEnabled() ? portal.PORTAL.url || '(PORTAL_URL fehlt)' : 'nicht verbunden – PORTAL_SSO_SECRET fehlt'}`);
  console.log(`  Rundown:   ${rd.rundownApi() ? rd.RUNDOWN.url : rd.rundownLinked() ? rd.RUNDOWN.url + ' (nur Links, RUNDOWN_API_SECRET fehlt)' : 'nicht verbunden'}`);
  console.log('');
  if (portal.directoryEnabled()) {
    const run = () => portal.syncDirectory().then((r) => { if (!r.ok) console.warn('  Mitgliederliste:', r.error); });
    setTimeout(run, 1500).unref();
    setInterval(run, SYNC_MINUTES * 60000).unref();
  }
});

function shutdown(code = 0) {
  server.close(() => { try { db.close(); } catch { /* */ } process.exit(code); });
  setTimeout(() => process.exit(code), 3000).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
