// Ende-zu-Ende-Tests: Anmeldung über das Portal, Termine, Rückmeldungen, Besetzung, Mitgliederliste, Rundown
// Start: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 's'.repeat(48);
const RD_SECRET = 'r'.repeat(40);
const PORT = 5200 + Math.floor(Math.random() * 3000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ffpl-test-'));
let proc, fakePortal, fakeRundown;

/* ---------- Ersatz für Portal (Mitgliederliste) und FF Rundown (Schnittstelle) */
const people = [
  { sub: '1', email: 'chef@example.de', name: 'Chef', role: 'admin', kind: 'member', platform_admin: true, modules: { planner: 'admin', rundown: 'admin' } },
  { sub: '2', email: 'paula@example.de', name: 'Paula Planer', role: 'planner', kind: 'member', modules: { planner: 'planner', rundown: 'editor' } },
  { sub: '3', email: 'max@example.de', name: 'Max Kamera', role: 'member', kind: 'member', modules: { planner: 'member' } },
  { sub: '4', email: 'nie@example.de', name: 'Nie Da', role: 'member', kind: 'member', modules: { planner: 'member' } },
  { sub: '5', email: 'gast@extern.de', name: 'Gast', role: 'member', kind: 'guest', modules: { planner: 'member' } },
];
const rundowns = [{ id: 11, title: 'Finale Ablauf', event_date: '2030-05-01', start_time: '18:00', owner: 'paula@example.de' }];
const okSig = (h, secret, prefix, msg) => {
  const [ts, sig] = String(h || '').replace(prefix, '').split('.');
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 120) return false;
  return sig === crypto.createHmac('sha256', secret).update(msg(ts)).digest('base64url');
};
function listen(handler) {
  return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
}
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b ? JSON.parse(b) : {})); });
const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

before(async () => {
  fakePortal = await listen((req, res) => {
    if (req.url !== '/api/modules/planner/directory') return reply(res, 404, {});
    if (!okSig(req.headers.authorization, SECRET, 'Portal ', (ts) => `directory:planner:${ts}`)) return reply(res, 401, { error: 'nein' });
    reply(res, 200, { module: 'planner', users: people });
  });
  fakeRundown = await listen(async (req, res) => {
    if (!okSig(req.headers.authorization, RD_SECRET, 'Planner ', (ts) => `rundown-api:${ts}`)) return reply(res, 401, { error: 'nein' });
    const u = new URL(req.url, 'http://x');
    const email = u.searchParams.get('email');
    const role = (mail) => (mail === 'paula@example.de' || mail === 'chef@example.de' ? 'editor' : null);
    const out = (r, mail) => ({ id: r.id, title: r.title, event_date: r.event_date, my_role: role(mail), path: `/#/rundown/${r.id}` });
    if (req.method === 'GET' && u.pathname === '/api/ext/rundowns') return reply(res, 200, { user: { found: !!role(email), can_create: !!role(email) }, rundowns: role(email) ? rundowns.map((r) => out(r, email)) : [] });
    const m = u.pathname.match(/^\/api\/ext\/rundowns\/(\d+)$/);
    if (req.method === 'GET' && m) {
      const r = rundowns.find((x) => x.id === Number(m[1]));
      return r ? reply(res, 200, { exists: true, ...(role(email) ? out(r, email) : { id: r.id, my_role: null }) }) : reply(res, 404, { error: 'Rundown nicht gefunden' });
    }
    if (req.method === 'POST' && u.pathname === '/api/ext/rundowns') {
      const b = await body(req);
      if (!role(b.email)) return reply(res, 403, { error: 'Keine Berechtigung, Rundowns anzulegen' });
      const r = { id: 12 + rundowns.length, title: b.title, event_date: b.event_date };
      rundowns.push(r);
      return reply(res, 200, out(r, b.email));
    }
    reply(res, 404, {});
  });
  proc = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, PORTAL_URL: `http://127.0.0.1:${fakePortal.address().port}`, PORTAL_SSO_SECRET: SECRET,
      RUNDOWN_URL: `http://127.0.0.1:${fakeRundown.address().port}`, RUNDOWN_API_SECRET: RD_SECRET },
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Server startet nicht');
});
after(() => { proc?.kill(); fakePortal?.close(); fakeRundown?.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

/* ---------- Hilfen */
function ticket(p, over = {}, secret = SECRET) {
  const iat = Math.floor(Date.now() / 1000);
  const b = Buffer.from(JSON.stringify({ v: 1, iss: 'ff-broadcast-portal', aud: 'planner', sub: p.sub, email: p.email, name: p.name, role: p.role, kind: p.kind, platform_admin: !!p.platform_admin, iat, exp: iat + 60, jti: crypto.randomBytes(8).toString('hex'), ...over })).toString('base64url');
  return `${b}.${crypto.createHmac('sha256', secret).update(b).digest('base64url')}`;
}
async function login(p, next) {
  const r = await fetch(`${BASE}/auth/portal?ticket=${encodeURIComponent(ticket(p))}${next ? '&next=' + encodeURIComponent(next) : ''}`, { redirect: 'manual' });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const call = async (method, url, b) => {
    const x = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: x.status, data: await x.json().catch(() => null) };
  };
  return { cookie, location: r.headers.get('location'), get: (u) => call('GET', u), post: (u, b = {}) => call('POST', u, b), put: (u, b = {}) => call('PUT', u, b), patch: (u, b = {}) => call('PATCH', u, b), del: (u) => call('DELETE', u), raw: (u) => fetch(BASE + u, { headers: { Cookie: cookie } }) };
}
const [CHEF, PAULA, MAX, NIE, GAST] = people;

test('Anmeldung nur mit gültiger, einmaliger Eintrittskarte aus dem Portal', async () => {
  const anon = await fetch(BASE + '/api/events');
  assert.equal(anon.status, 401);
  const st = await (await fetch(BASE + '/api/status')).json();
  assert.equal(st.user, null);
  assert.match(st.portal.login, /\/sso\/planner$/);

  const t = ticket(MAX);
  const ok = await fetch(`${BASE}/auth/portal?ticket=${encodeURIComponent(t)}`, { redirect: 'manual' });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/');
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await fetch(`${BASE}/auth/portal?ticket=${encodeURIComponent(t)}`, { redirect: 'manual' })).status, 401); // zweimal
  for (const bad of [ticket(MAX, {}, 'x'.repeat(48)), ticket(MAX, { aud: 'rundown' }), ticket(MAX, { exp: 1 }), 'kaputt']) {
    assert.equal((await fetch(`${BASE}/auth/portal?ticket=${encodeURIComponent(bad)}`, { redirect: 'manual' })).status, 401);
  }
  assert.equal((await fetch(`${BASE}/auth/portal?ticket=${encodeURIComponent(ticket(MAX, { role: 'chef' }))}`, { redirect: 'manual' })).status, 403);
  assert.equal((await login(MAX, '/#/termin/3')).location, '/#/termin/3');
  assert.equal((await login(MAX, '//boese.de')).location, '/');
  const me = (await (await login(PAULA)).get('/api/status')).data.user;
  assert.equal(me.can_plan, true);
  assert.equal(me.is_admin, false);
});

test('Ablauf: Termin anlegen → freigeben → Rückmeldungen → Besetzung → offene Stellen', async () => {
  const paula = await login(PAULA);
  const max = await login(MAX);
  const gast = await login(GAST);
  const chef = await login(CHEF);

  // Mitglieder dürfen nicht planen
  assert.equal((await max.post('/api/events', { title: 'X', date: '2030-05-01' })).status, 403);
  assert.equal((await paula.post('/api/events', { title: '', date: '2030-05-01' })).status, 400);
  assert.equal((await paula.post('/api/events', { title: 'X', date: '1.5.2030' })).status, 400);

  const pos = (await paula.get('/api/positions')).data.positions;
  assert.deepEqual(pos.map((p) => p.name), ['Regie', 'Grafik', 'Ton', 'Spec', 'Replay', 'Mod', 'Caster']);
  const kamera = pos.find((p) => p.name === 'Caster');
  const c = await paula.post('/api/events', {
    title: 'FrankenFinals Finale', date: '2030-05-01', start_time: '18:00', end_time: '23:00', meet_time: '15:00', location: 'Halle 3',
    slots: [{ position_id: kamera.id, needed: 2 }, { name: 'Regie', needed: 1 }],
  });
  assert.equal(c.status, 200);
  const id = c.data.id;

  // Entwurf: für Mitglieder unsichtbar
  assert.equal((await max.get(`/api/events/${id}`)).status, 404);
  assert.ok(!(await max.get('/api/events')).data.events.some((e) => e.id === id));

  // Freigeben → Mitglieder sehen ihn und melden sich
  assert.equal((await paula.patch(`/api/events/${id}`, { status: 'open' })).status, 200);
  let ev = (await max.get(`/api/events/${id}`)).data;
  assert.equal(ev.respond_open, true);
  assert.equal(ev.people, undefined); // Personenliste nur für Planer
  const camSlot = ev.slots.find((s) => s.name === 'Caster');
  assert.equal((await max.put(`/api/events/${id}/response`, { status: 'vielleicht' })).status, 400);
  ev = (await max.put(`/api/events/${id}/response`, { status: 'yes', comment: 'ab 16 Uhr', wishes: [camSlot.id, 9999] })).data;
  assert.equal(ev.my_response.status, 'yes');
  assert.deepEqual(ev.responses.find((r) => r.sub === MAX.sub).wishes, [camSlot.id]);
  assert.equal((await max.put(`/api/events/${id}/response`, { status: 'no', sub: NIE.sub })).status, 403); // nicht für andere
  // Planer trägt für jemanden ein (z. B. am Telefon abgesagt)
  await paula.post('/api/people/sync');
  ev = (await paula.put(`/api/events/${id}/response`, { status: 'no', sub: NIE.sub })).data;
  assert.equal(ev.responses.find((r) => r.sub === NIE.sub).by_planner, true);
  assert.equal(ev.counts.yes, 1);
  assert.equal(ev.counts.no, 1);

  // Gast sieht den Termin nicht, bis er eingeteilt ist
  assert.equal((await gast.get(`/api/events/${id}`)).status, 404);

  // Besetzung
  assert.equal((await max.post(`/api/events/${id}/assign`, { slot_id: camSlot.id, sub: MAX.sub })).status, 403);
  ev = (await paula.post(`/api/events/${id}/assign`, { slot_id: camSlot.id, sub: MAX.sub })).data;
  assert.equal(ev.slots.find((s) => s.name === 'Caster').open, 1);
  assert.equal((await paula.post(`/api/events/${id}/assign`, { slot_id: camSlot.id, sub: MAX.sub })).status, 400); // doppelt
  ev = (await paula.post(`/api/events/${id}/assign`, { slot_id: camSlot.id, sub: GAST.sub })).data;
  assert.equal((await paula.post(`/api/events/${id}/assign`, { slot_id: camSlot.id, sub: NIE.sub })).status, 400); // voll
  assert.equal(ev.open, 1); // Regie fehlt noch
  assert.deepEqual(ev.open_slots.map((s) => s.name), ['Regie']);
  assert.equal((await gast.get(`/api/events/${id}`)).status, 200);
  assert.deepEqual((await gast.get(`/api/events/${id}`)).data.my_slots, ['Caster']);

  // Anzahl unter die Besetzung verringern → abgelehnt
  const slots = ev.slots.map((s) => ({ id: s.id, name: s.name, position_id: s.position_id, needed: s.needed }));
  assert.equal((await paula.patch(`/api/events/${id}`, { slots: slots.map((s) => (s.name === 'Caster' ? { ...s, needed: 1 } : s)) })).status, 400);

  // Meine Einsätze & offene Stellen
  const mine = (await max.get('/api/events?scope=mine')).data.events;
  assert.deepEqual(mine.map((e) => [e.id, e.my_slots]), [[id, ['Caster']]]);
  const open = (await max.get('/api/events?scope=open')).data.events;
  assert.equal(open[0].id, id);

  // Abfrage schließen → Mitglieder können nicht mehr ändern, Planer schon
  await paula.patch(`/api/events/${id}`, { status: 'closed' });
  assert.equal((await max.put(`/api/events/${id}/response`, { status: 'no' })).status, 400);
  assert.equal((await paula.put(`/api/events/${id}/response`, { status: 'later', from_time: '19:30', sub: MAX.sub })).status, 200);

  // Einteilung entfernen
  const asg = ev.slots.find((s) => s.name === 'Caster').assigned.find((a) => a.sub === GAST.sub);
  assert.equal((await paula.del(`/api/events/${id}/assign/${asg.id}`)).status, 200);
  assert.equal((await gast.get(`/api/events/${id}`)).status, 404);

  // Kalender-Datei
  const ics = await (await max.raw(`/api/events/${id}/ics`)).text();
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /SUMMARY:FrankenFinals Finale \(Caster\)/);
  assert.match(ics, /DTSTART;TZID=Europe\/Berlin:20300501T150000/);

  // Verlauf und Löschen: freigegebene Termine nur Planer-Admin
  assert.ok((await paula.get(`/api/events/${id}`)).data.log.some((l) => l.action === 'assigned'));
  assert.equal((await paula.del(`/api/events/${id}`)).status, 403);
  const copy = (await paula.post(`/api/events/${id}/duplicate`, { date: '2030-06-01' })).data.id;
  const cp = (await paula.get(`/api/events/${copy}`)).data;
  assert.equal(cp.status, 'draft');
  assert.deepEqual(cp.slots.map((s) => [s.name, s.needed, s.assigned.length]), [['Caster', 2, 0], ['Regie', 1, 0]]);
  assert.equal((await paula.del(`/api/events/${copy}`)).status, 200);
  assert.equal((await chef.del(`/api/events/${id}`)).status, 200);
});

test('Mitgliederliste aus dem Portal: Leute einteilbar, auch wenn sie das Modul nie geöffnet haben', async () => {
  const paula = await login(PAULA);
  const r = await paula.post('/api/people/sync');
  assert.equal(r.status, 200);
  assert.equal(r.data.count, people.length);
  const list = (await paula.get('/api/people')).data;
  assert.ok(list.people.some((p) => p.sub === NIE.sub && p.active));
  assert.equal(list.people.find((p) => p.sub === PAULA.sub).has_rundown, true);
  assert.equal((await (await login(MAX)).get('/api/people')).status, 403);

  // Person verliert im Portal den Zugriff → inaktiv, Sitzung beendet
  const nie = await login(NIE);
  assert.equal((await nie.get('/api/events')).status, 200);
  const removed = people.splice(3, 1);
  await paula.post('/api/people/sync');
  assert.equal((await nie.get('/api/events')).status, 401);
  assert.equal((await paula.get('/api/people')).data.people.find((p) => p.sub === NIE.sub).active, false);
  people.splice(3, 0, ...removed);
  await paula.post('/api/people/sync');
});

test('Rundown hinterlegen: vorhandenen auswählen oder neu anlegen – mit den Rechten aus FF Rundown', async () => {
  const paula = await login(PAULA);
  const max = await login(MAX);
  const id = (await paula.post('/api/events', { title: 'Show', date: '2030-07-01', start_time: '19:00', status: 'open' })).data.id;

  const list = (await paula.get(`/api/events/${id}/rundowns`)).data;
  assert.equal(list.user.can_create, true);
  assert.deepEqual(list.rundowns.map((r) => r.title), ['Finale Ablauf']);
  let ev = (await paula.put(`/api/events/${id}/rundown`, { rundown_id: 11 })).data;
  assert.equal(ev.rundown.title, 'Finale Ablauf');
  assert.match(ev.rundown.link, /\/sso\/rundown\?next=%2F%23%2Frundown%2F11$/);

  // Max hat das Modul Rundown nicht → sieht den Titel, aber keinen Link
  assert.equal((await max.get(`/api/events/${id}`)).data.rundown.link, null);

  ev = (await paula.post(`/api/events/${id}/rundown`, {})).data;
  assert.equal(ev.rundown.title, 'Show');
  assert.equal((await paula.del(`/api/events/${id}/rundown`)).data.rundown, null);
  assert.equal((await max.get(`/api/events/${id}/rundowns`)).status, 403);
});

test('Stellen-Liste nur für Planer-Admins änderbar', async () => {
  const chef = await login(CHEF);
  const paula = await login(PAULA);
  assert.equal((await paula.post('/api/positions', { name: 'Drohne' })).status, 403);
  assert.equal((await chef.post('/api/positions', { name: 'Drohne' })).status, 200);
  assert.equal((await chef.post('/api/positions', { name: 'drohne' })).status, 400);
  const p = (await chef.get('/api/positions')).data.positions.find((x) => x.name === 'Drohne');
  assert.equal((await chef.patch(`/api/positions/${p.id}`, { active: false })).status, 200);
  assert.equal((await chef.get('/api/positions')).data.positions.find((x) => x.id === p.id).active, false);
  assert.equal((await chef.del(`/api/positions/${p.id}`)).status, 200);
});

test('Rückmeldungen: vor Ort, später (mit Uhrzeit), online, kann nicht – jeweils mit Kommentar', async () => {
  const paula = await login(PAULA);
  const max = await login(MAX);
  const nie = await login(NIE);
  const id = (await paula.post('/api/events', { title: 'Stream', date: '2030-08-01', start_time: '18:00', status: 'open' })).data.id;
  const put = (c, b) => c.put(`/api/events/${id}/response`, b);

  // Später ohne/mit falscher Uhrzeit → abgelehnt
  assert.equal((await put(max, { status: 'later' })).status, 400);
  assert.equal((await put(max, { status: 'later', from_time: '25:00' })).status, 400);
  let ev = (await put(max, { status: 'later', from_time: '19:30', comment: 'Arbeit bis 19 Uhr' })).data;
  assert.deepEqual(ev.my_response, { status: 'later', from_time: '19:30', comment: 'Arbeit bis 19 Uhr', wishes: [] });
  // Kommentar ändern ohne Uhrzeit erneut zu schicken → Uhrzeit bleibt
  ev = (await put(max, { status: 'later', comment: 'doch erst 20 Uhr?' })).data;
  assert.equal(ev.my_response.from_time, '19:30');
  // Wechsel auf online → Uhrzeit fällt weg, Kommentar möglich
  ev = (await put(max, { status: 'online', comment: 'nur Kommentar-Mikro' })).data;
  assert.equal(ev.my_response.status, 'online');
  assert.equal(ev.my_response.from_time, '');
  assert.equal(ev.my_response.comment, 'nur Kommentar-Mikro');
  ev = (await put(nie, { status: 'no', comment: 'Urlaub' })).data;
  ev = (await put(paula, { status: 'yes', comment: 'bringe Kabel mit' })).data;
  assert.deepEqual(ev.counts, { yes: 1, later: 0, online: 1, no: 1 });
  assert.equal(ev.responses.find((r) => r.sub === NIE.sub).comment, 'Urlaub');
  assert.equal((await put(max, { status: 'maybe' })).status, 400); // „Vielleicht“ gibt es nicht mehr
  // Planer trägt „später“ für jemanden ein
  ev = (await put(paula, { status: 'later', from_time: '20:00', sub: NIE.sub, comment: 'per Telefon' })).data;
  const n = ev.responses.find((r) => r.sub === NIE.sub);
  assert.equal(n.status, 'later');
  assert.equal(n.from_time, '20:00');
  assert.equal(n.by_planner, true);
  assert.ok(ev.log.some((l) => l.detail.includes('später ab 20:00')));
});

test('Live-Aktualisierung: andere Browser erfahren sofort von Änderungen, der eigene Tab nicht doppelt', async () => {
  const paula = await login(PAULA);
  const max = await login(MAX);
  assert.equal((await fetch(BASE + '/api/live')).status, 401);
  const res = await max.raw('/api/live');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const msgs = [];
  let buf = '';
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (line) msgs.push(JSON.parse(line.slice(6)));
      }
    }
  })();
  const waitFor = async (pred) => {
    for (let i = 0; i < 40; i++) { const m = msgs.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error('Keine Live-Meldung: ' + JSON.stringify(msgs));
  };
  const r = await fetch(BASE + '/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: paula.cookie, 'X-Client-Id': 'tab-paula' }, body: JSON.stringify({ title: 'Live', date: '2030-09-01', status: 'open' }) });
  const id = (await r.json()).id;
  const m1 = await waitFor((m) => m.kind === 'events' && m.id === id);
  assert.equal(m1.from, 'tab-paula');
  assert.equal(m1.deleted, false);
  await paula.put(`/api/events/${id}/response`, { status: 'online' });
  await waitFor((m) => m.kind === 'events' && m.id === id && !m.from);
  assert.equal((await (await login(CHEF)).del(`/api/events/${id}`)).status, 200);
  await waitFor((m) => m.deleted && m.id === id);
  await paula.post('/api/people/sync');
  await waitFor((m) => m.kind === 'people');
  reader.cancel();
  await pump.catch(() => {});
});
