// FF-Planner – Oberfläche (ohne Framework, Design wie im Portal)
import { h, icon, toast, fill, menu, modal, popover, closePop, confirmDialog, themeToggle } from './ui.js';
import { get, post, put, patch, del, initials, fmtDay, fmtDayNum, fmtMonShort, fmtMonth, fmtLong, fmtShort, fmtAgo, timeRange, daysUntil } from './api.js';

const S = { user: null, status: null, positions: null };
const root = document.body.appendChild(document.createElement('div'));
root.id = 'app';

const STATUS = {
  draft: { label: 'Entwurf', cls: '' },
  open: { label: 'Abfrage läuft', cls: 'green' },
  closed: { label: 'Abfrage beendet', cls: 'accent' },
  cancelled: { label: 'Abgesagt', cls: 'red' },
};
// Rückmeldungen: vor Ort (grün) · später mit Uhrzeit (orange) · online (blau) · kann nicht (rot)
const RESP = {
  yes: { label: 'Vor Ort', icon: 'mapPin', chip: 'green' },
  later: { label: 'Später', icon: 'clock', chip: 'orange' },
  online: { label: 'Online', icon: 'monitor', chip: 'blue' },
  no: { label: 'Kann nicht', icon: 'x', chip: 'red' },
};
/** Text einer Rückmeldung, z. B. „Später ab 17:00“ */
const respText = (r) => (r.status === 'later' && r.from_time ? `Später ab ${r.from_time}` : RESP[r.status]?.label || r.status);
const ROLE = { member: 'Mitglied', planner: 'Planer', admin: 'Planer-Admin' };
const planner = () => !!S.user?.can_plan;
const busy = async (btn, fn) => { if (btn) btn.disabled = true; try { return await fn(); } catch (e) { toast(e.message, 'err'); } finally { if (btn) btn.disabled = false; } };

/* ------------------------------------------------------------ Bausteine */
const brand = () => h('div', { class: 'brand' },
  h('span', { class: 'brand-mark' }, icon('logo')),
  h('span', { class: 'brand-name' }, h('b', null, 'Frankenfinals'), h('span', null, 'Terminplanung')));
const field = (label, input, hint) => h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
const input = (props) => h('input', { class: 'input', ...props });
const statusChip = (s) => h('span', { class: 'chip ' + (STATUS[s]?.cls || '') }, STATUS[s]?.label || s);
const avatar = (p, cls = '') => h('span', { class: 'avatar ' + cls, title: p.name }, initials(p));

function authScreen(...kids) {
  fill(root, h('div', { class: 'auth-wrap' }, h('div', { class: 'auth-card' }, brand(), ...kids)));
}

const NAV = () => [
  { href: '#/', label: 'Termine', icon: 'calendar', match: (p) => p === '/' || p.startsWith('/termin') || p === '/vergangen' },
  { href: '#/offen', label: 'Offene Stellen', icon: 'userPlus', match: (p) => p === '/offen' },
  { href: '#/meine', label: 'Meine Einsätze', icon: 'calendarCheck', match: (p) => p === '/meine' },
  planner() ? { href: '#/verwaltung', label: 'Verwaltung', icon: 'users', match: (p) => p.startsWith('/verwaltung') } : null,
].filter(Boolean);

function shell(path, ...content) {
  const u = S.user;
  const portalUrl = S.status?.portal?.url;
  const userBtn = h('button', { class: 'user-btn', onclick: (e) => menu(e.currentTarget, [
    portalUrl ? { label: 'Zum Portal', icon: 'grid', onClick: () => { location.href = portalUrl + '/'; } } : null,
    { label: document.documentElement.dataset.theme === 'light' ? 'Dunkles Design' : 'Helles Design', icon: document.documentElement.dataset.theme === 'light' ? 'moon' : 'sun', onClick: () => document.querySelector('.topbar .theme-toggle')?.click() },
    { sep: true },
    { label: 'Abmelden', icon: 'logout', onClick: logout },
  ]) },
    h('span', { class: 'avatar sm' }, initials(u)),
    h('span', { class: 'user-btn-txt' }, h('b', null, u.name || u.email), h('span', null, u.kind === 'guest' && !u.can_plan ? 'Gast' : ROLE[u.role] || u.role)), icon('chevronDown'));
  fill(root,
    h('header', { class: 'topbar' },
      h('a', { href: '#/' }, brand()),
      h('nav', { class: 'nav' }, NAV().map((n) => h('a', { href: n.href, class: n.match(path) ? 'active' : '', title: n.label, 'aria-label': n.label }, icon(n.icon), h('span', { class: 'nav-lbl' }, n.label)))),
      h('div', { class: 'spacer' }),
      portalUrl ? h('a', { class: 'icon-btn portal-link', href: portalUrl + '/', title: 'Zum Portal', 'aria-label': 'Zum Portal' }, icon('grid')) : null,
      themeToggle(), userBtn),
    h('main', { class: 'page' }, ...content));
}

/* ------------------------------------------------------------ Rückmelde-Knöpfe */
/** Dialog für eine Rückmeldung mit Uhrzeit (bei „Später“) und Kommentar – auch für Planer, die für andere eintragen */
function responseDialog(ev, status, { sub = null, who = null, current = null, onDone } = {}) {
  const r = RESP[status];
  const time = input({ type: 'time', value: current?.from_time || ev.start_time || '', required: true });
  const comment = h('textarea', { class: 'input', rows: 2, maxlength: 300, placeholder: status === 'later' ? 'Optional: warum später, z. B. „Arbeit bis 16 Uhr“' : status === 'no' ? 'Optional: Grund' : 'Optional: Kommentar' }, current?.comment || '');
  const err = h('div', { class: 'form-error' });
  const m = modal({
    title: (who ? `${who}: ` : '') + r.label,
    body: h('div', null,
      status === 'later' ? field(who ? 'Ab wann ist die Person da?' : 'Ab wann bist du da?', time, ev.start_time ? `Beginn ist ${ev.start_time} Uhr${ev.meet_time ? `, Treffen ${ev.meet_time} Uhr` : ''}.` : null) : null,
      field('Kommentar', comment), err),
    actions: [{ label: 'Abbrechen', class: 'ghost' }, { label: 'Speichern', class: 'primary', onClick: async () => {
      try {
        onDone?.(await put(`/api/events/${ev.id}/response`, { status, comment: comment.value, ...(status === 'later' ? { from_time: time.value } : {}), ...(current?.wishes && status !== 'no' ? { wishes: current.wishes } : {}), ...(sub ? { sub } : {}) }));
      } catch (e) { err.textContent = e.message; return false; }
    } }],
  });
  setTimeout(() => (status === 'later' ? time : comment).focus(), 40);
  return m;
}

function respButtons(ev, { big = false, onDone } = {}) {
  const mine = ev.my_response || null;
  const cur = mine?.status || null;
  const wrap = h('div', { class: 'rsp' + (big ? ' big' : '') });
  for (const [k, r] of Object.entries(RESP)) {
    const label = k === 'later' && cur === 'later' && mine.from_time ? `ab ${mine.from_time}` : r.label;
    wrap.append(h('button', { type: 'button', class: k + (cur === k ? ' sel' : ''), title: r.label, onclick: async (e) => {
      e.preventDefault(); e.stopPropagation();
      // „Später“ braucht eine Uhrzeit → Dialog (auch zum Ändern der Uhrzeit)
      if (k === 'later') return responseDialog(ev, 'later', { current: mine, onDone });
      await busy(e.currentTarget, async () => {
        const d = await put(`/api/events/${ev.id}/response`, { status: cur === k && !big ? null : k });
        onDone?.(d);
      });
    } }, icon(r.icon), h('span', { class: 'lbl' }, label)));
  }
  return wrap;
}

/* ------------------------------------------------------------ Terminkarte */
function eventCard(ev, { onChange } = {}) {
  const today = daysUntil(ev.date) === 0;
  const fullTxt = ev.needed ? (ev.open ? `${ev.filled}/${ev.needed} besetzt` : 'Voll besetzt') : null;
  return h('a', { class: `ev-card ${ev.status}`, href: `#/termin/${ev.id}` },
    h('div', { class: 'ev-date' + (today ? ' today' : '') }, h('span', { class: 'wd' }, today ? 'Heute' : fmtDay(ev.date)), h('span', { class: 'd' }, fmtDayNum(ev.date)), h('span', { class: 'm' }, fmtMonShort(ev.date))),
    h('div', { class: 'ev-main' },
      h('div', { class: 'ev-title-row' }, h('h3', null, ev.title), ev.status !== 'open' ? statusChip(ev.status) : null),
      h('div', { class: 'ev-meta' },
        ev.start_time ? h('span', null, icon('clock'), timeRange(ev)) : null,
        ev.meet_time ? h('span', null, icon('users'), `Treffen ${ev.meet_time}`) : null,
        ev.location ? h('span', null, icon('mapPin'), ev.location) : null),
      h('div', { class: 'chips' },
        ev.my_slots.length ? h('span', { class: 'chip accent' }, icon('check'), 'Du: ' + ev.my_slots.join(', ')) : null,
        fullTxt ? h('span', { class: 'chip ' + (ev.open ? 'amber' : 'green') }, fullTxt) : null,
        ev.open ? h('span', { class: 'chip' }, `${ev.open} offen`) : null,
        ev.rundown ? h('span', { class: 'chip' }, icon('list'), 'Rundown') : null,
        h('span', { class: 'counts', title: 'Vor Ort · Später · Online · Kann nicht' },
          Object.entries(RESP).map(([k, r]) => h('span', { class: 'c-' + k }, icon(r.icon), ev.counts[k] || 0))))),
    h('div', { class: 'ev-side' },
      ev.respond_open ? respButtons(ev, { onDone: onChange }) : ev.my_response ? h('span', { class: 'chip ' + RESP[ev.my_response.status]?.chip }, respText(ev.my_response)) : null));
}

function groupByMonth(events) {
  const out = [];
  let cur = null;
  for (const e of events) {
    const m = fmtMonth(e.date);
    if (m !== cur) { out.push(h('div', { class: 'section-title' }, m)); cur = m; }
    out.push(eventCard(e, { onChange: () => render() }));
  }
  return out;
}

/* ------------------------------------------------------------ Seite: Termine */
async function eventsPage(past = false) {
  const list = h('div', { class: 'ev-list' }, h('div', { class: 'empty' }, 'Lädt …'));
  shell(past ? '/vergangen' : '/',
    h('div', { class: 'page-head row' },
      h('div', null, h('span', { class: 'label' }, 'TERMINPLANUNG'), h('h1', null, 'Termine'),
        h('p', { class: 'sub' }, planner() ? 'Termine anlegen, freigeben und die Crew einteilen.' : 'Trag ein, ob du kannst – die Planer teilen dann die Stellen ein.')),
      h('div', { class: 'spacer' }),
      planner() ? h('button', { class: 'btn primary', onclick: () => eventForm() }, icon('plus'), 'Termin anlegen') : null),
    h('div', { class: 'tabs' }, h('a', { href: '#/', class: past ? '' : 'active' }, 'Kommende'), h('a', { href: '#/vergangen', class: past ? 'active' : '' }, 'Vergangene')),
    list);
  let data;
  try { data = await get('/api/events?scope=' + (past ? 'past' : 'upcoming')); } catch (e) { return fill(list, h('div', { class: 'empty' }, e.message)); }
  if (!data.events.length) {
    return fill(list, h('div', { class: 'empty' }, h('b', null, past ? 'Noch nichts vorbei' : 'Keine Termine'),
      past ? 'Hier landen Termine, sobald sie vorbei sind.' : planner() ? 'Leg den ersten Termin an und gib ihn frei, damit sich alle eintragen können.' : 'Sobald ein Planer Termine freigibt, erscheinen sie hier.'));
  }
  fill(list, groupByMonth(data.events));
}

/* ------------------------------------------------------------ Seite: Offene Stellen */
async function openPage() {
  const list = h('div', { class: 'ev-list' }, h('div', { class: 'empty' }, 'Lädt …'));
  shell('/offen',
    h('div', { class: 'page-head' }, h('span', { class: 'label' }, 'TERMINPLANUNG'), h('h1', null, 'Offene Stellen'),
      h('p', { class: 'sub' }, 'Hier fehlen noch Leute. Markier, was du übernehmen würdest – die Planer sehen deinen Wunsch beim Einteilen.')),
    list);
  let data;
  try { data = await get('/api/events?scope=open'); } catch (e) { return fill(list, h('div', { class: 'empty' }, e.message)); }
  if (!data.events.length) return fill(list, h('div', { class: 'empty' }, h('b', null, 'Alles besetzt'), 'Gerade gibt es keine offenen Stellen.'));
  const cards = [];
  for (const ev of data.events) {
    const mine = ev.my_response;
    const wishes = new Set(mine?.wishes || []);
    cards.push(h('div', { class: 'card card-pad open-card' },
      h('div', { class: 'card-head' },
        h('div', { class: 'ev-date', style: { width: '54px', height: '54px' } }, h('span', { class: 'wd' }, fmtDay(ev.date)), h('span', { class: 'd', style: { fontSize: '22px' } }, fmtDayNum(ev.date)), h('span', { class: 'm' }, fmtMonShort(ev.date))),
        h('div', { style: { minWidth: 0 } }, h('a', { href: `#/termin/${ev.id}` }, h('h3', null, ev.title)), h('div', { class: 'ev-meta' }, ev.start_time ? h('span', null, icon('clock'), timeRange(ev)) : null, ev.location ? h('span', null, icon('mapPin'), ev.location) : null)),
        h('div', { class: 'spacer' }),
        ev.status === 'closed' ? statusChip('closed') : null),
      h('div', { class: 'open-slots' }, ev.open_slots.map((s) => h('span', { class: 'open-slot' }, s.name, h('span', { class: 'n' }, `${s.open}×`),
        ev.respond_open && mine?.status !== 'no' ? h('button', { class: wishes.has(s.id) ? 'sel' : '', onclick: (e) => busy(e.currentTarget, async () => {
          const next = new Set(wishes);
          if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
          await put(`/api/events/${ev.id}/response`, { status: mine?.status || 'yes', wishes: [...next] });
          toast(next.has(s.id) ? `Wunsch „${s.name}“ eingetragen` : 'Wunsch entfernt', 'ok');
          openPage();
        }) }, wishes.has(s.id) ? 'Gemeldet' : 'Würde ich machen') : null))),
    ));
  }
  fill(list, cards);
}

/* ------------------------------------------------------------ Seite: Meine Einsätze */
async function minePage() {
  const list = h('div', { class: 'ev-list' }, h('div', { class: 'empty' }, 'Lädt …'));
  shell('/meine',
    h('div', { class: 'page-head' }, h('span', { class: 'label' }, 'TERMINPLANUNG'), h('h1', null, 'Meine Einsätze'),
      h('p', { class: 'sub' }, 'Termine, für die du eingeteilt bist. Über „In Kalender“ landen sie in deinem Kalender.')),
    list);
  let data;
  try { data = await get('/api/events?scope=mine'); } catch (e) { return fill(list, h('div', { class: 'empty' }, e.message)); }
  if (!data.events.length) return fill(list, h('div', { class: 'empty' }, h('b', null, 'Noch keine Einsätze'), 'Sobald dich ein Planer einteilt, steht es hier.'));
  fill(list, groupByMonth(data.events));
}

/* ------------------------------------------------------------ Seite: Termin */
async function eventPage(id) {
  let ev;
  try { ev = await get(`/api/events/${id}`); }
  catch (e) {
    return shell('/termin', h('a', { class: 'back', href: '#/' }, icon('arrowLeft'), 'Alle Termine'), h('div', { class: 'empty' }, h('b', null, 'Nicht gefunden'), e.message));
  }
  const repaint = (d) => paintEvent(d);
  paintEvent(ev);

  function paintEvent(ev) {
    const p = ev.can_plan;
    const acts = h('div', { class: 'acts' });
    if (p) {
      const st = (status, label, cls = '') => h('button', { class: 'btn ' + cls, onclick: (e) => busy(e.currentTarget, async () => repaint(await patch(`/api/events/${ev.id}`, { status }))) }, label);
      if (ev.status === 'draft') acts.append(st('open', 'Freigeben', 'primary'));
      if (ev.status === 'open') acts.append(st('closed', 'Abfrage beenden'));
      if (ev.status === 'closed') acts.append(st('open', 'Abfrage wieder öffnen'));
      if (ev.status === 'cancelled') acts.append(st('open', 'Wieder ansetzen'));
      acts.append(h('button', { class: 'btn', onclick: () => eventForm(ev) }, icon('edit'), 'Bearbeiten'));
      acts.append(h('button', { class: 'icon-btn', title: 'Mehr', 'aria-label': 'Mehr', onclick: (e) => menu(e.currentTarget, [
        { label: 'Kopieren (neuer Entwurf)', icon: 'copy', onClick: () => duplicateDialog(ev) },
        { label: 'In Kalender (.ics)', icon: 'download', onClick: () => { location.href = `/api/events/${ev.id}/ics`; } },
        ev.status !== 'cancelled' && ev.status !== 'draft' ? { label: 'Absagen', icon: 'ban', onClick: async () => {
          if (await confirmDialog('Der Termin bleibt sichtbar, ist aber als abgesagt markiert. Rückmeldungen und Besetzung bleiben erhalten.', { title: 'Termin absagen?', okLabel: 'Absagen' })) repaint(await patch(`/api/events/${ev.id}`, { status: 'cancelled' }));
        } } : null,
        ev.status === 'draft' || S.user.is_admin ? { sep: true } : null,
        ev.status === 'draft' || S.user.is_admin ? { label: 'Löschen', icon: 'trash', onClick: async () => {
          if (!(await confirmDialog(`„${ev.title}“ mit allen Rückmeldungen und Einteilungen endgültig löschen?`, { title: 'Termin löschen?' }))) return;
          await busy(null, async () => { await del(`/api/events/${ev.id}`); toast('Termin gelöscht', 'ok'); location.hash = '#/'; });
        } } : null,
      ]) }, icon('more')));
    } else {
      acts.append(h('a', { class: 'btn', href: `/api/events/${ev.id}/ics` }, icon('download'), 'In Kalender'));
    }

    const left = h('div', null, slotsCard(ev, repaint), responsesCard(ev, repaint));
    const right = h('div', null, myCard(ev, repaint), infoCard(ev), rundownCard(ev, repaint), p ? logCard(ev) : null);
    shell('/termin',
      h('a', { class: 'back', href: '#/' }, icon('arrowLeft'), 'Alle Termine'),
      h('div', { class: 'ev-head' },
        h('div', { class: 'txt' },
          h('span', { class: 'label', style: { color: 'var(--accent-2)', fontWeight: 600, letterSpacing: '.14em', fontSize: '12px' } }, fmtLong(ev.date).toUpperCase()),
          h('h1', null, ev.title),
          h('div', { class: 'chips' }, statusChip(ev.status), ev.my_slots.length ? h('span', { class: 'chip accent' }, icon('check'), 'Du: ' + ev.my_slots.join(', ')) : null,
            ev.needed ? h('span', { class: 'chip ' + (ev.open ? 'amber' : 'green') }, ev.open ? `${ev.open} von ${ev.needed} Stellen offen` : 'Voll besetzt') : null)),
        acts),
      ev.status === 'cancelled' ? h('div', { class: 'notice red', style: { marginBottom: '16px' } }, icon('ban'), 'Dieser Termin wurde abgesagt.') : null,
      ev.status === 'draft' ? h('div', { class: 'notice', style: { marginBottom: '16px' } }, icon('lock'), 'Entwurf – nur Planer sehen diesen Termin. Mit „Freigeben“ können sich alle eintragen.') : null,
      h('div', { class: 'ev-grid' }, left, right));
  }
}

function myCard(ev, repaint) {
  const mine = ev.responses.find((r) => r.sub === S.user.sub);
  const body = h('div', { class: 'stack' });
  const canEdit = ev.respond_open || ev.can_plan;
  if (canEdit) body.append(respButtons({ ...ev, my_response: mine || null }, { big: true, onDone: repaint }));
  else body.append(h('div', { class: 'notice' + (mine ? '' : ' warn') }, icon('info'),
    mine ? `Deine Rückmeldung: ${respText(mine)}.` : 'Du hast keine Rückmeldung gegeben.',
    ev.status === 'open' ? ' Die Rückmeldefrist ist vorbei.' : ev.status === 'closed' ? ' Die Abfrage ist beendet.' : ''));
  if (ev.respond_until && ev.status === 'open') body.append(h('small', { class: 'hint' }, `Rückmeldung bis ${fmtShort(ev.respond_until)}`));
  if (mine && canEdit) {
    const c = input({ value: mine.comment || '', maxlength: 300,
      placeholder: { yes: 'Kommentar (optional)', later: 'Warum später? (optional)', online: 'Kommentar (optional)', no: 'Grund (optional)' }[mine.status] });
    const save = (extra) => busy(null, async () => { repaint(await put(`/api/events/${ev.id}/response`, { status: mine.status, comment: c.value, wishes: mine.wishes, ...extra })); toast('Gespeichert', 'ok'); });
    if (mine.status === 'later') {
      const t = input({ type: 'time', value: mine.from_time || '' });
      t.addEventListener('change', () => { if (t.value && t.value !== mine.from_time) save({ from_time: t.value }); });
      body.append(field('Ab wann bist du da?', t));
    }
    c.addEventListener('change', () => { if (c.value !== (mine.comment || '')) save(); });
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); c.blur(); } });
    body.append(c);
    if (mine.status !== 'no' && ev.slots.length) {
      const wishes = new Set(mine.wishes || []);
      body.append(h('div', null, h('small', { class: 'hint' }, 'Was würdest du gern machen? (optional)'),
        h('div', { class: 'wish-chips' }, ev.slots.map((s) => h('button', { type: 'button', class: wishes.has(s.id) ? 'sel' : '', onclick: (e) => busy(e.currentTarget, async () => {
          if (wishes.has(s.id)) wishes.delete(s.id); else wishes.add(s.id);
          repaint(await put(`/api/events/${ev.id}/response`, { status: mine.status, comment: c.value, wishes: [...wishes] }));
        }) }, wishes.has(s.id) ? icon('star') : null, s.name)))));
    }
  }
  return h('div', { class: 'card card-pad' }, h('div', { class: 'card-head' }, h('h3', null, 'Deine Rückmeldung')), body);
}

function infoCard(ev) {
  const rows = [
    h('div', null, icon('calendar'), h('span', null, fmtLong(ev.date))),
    ev.start_time ? h('div', null, icon('clock'), h('span', null, timeRange(ev))) : null,
    ev.meet_time ? h('div', null, icon('users'), h('span', null, `Treffen / Aufbau ${ev.meet_time} Uhr`)) : null,
    ev.location ? h('div', null, icon('mapPin'), h('span', null, ev.location)) : null,
    ev.respond_until ? h('div', null, icon('timer'), h('span', null, `Rückmeldung bis ${fmtShort(ev.respond_until)}`)) : null,
  ];
  return h('div', { class: 'card card-pad' }, h('div', { class: 'card-head' }, h('h3', null, 'Infos')),
    h('div', { class: 'info-list' }, rows), ev.description ? h('p', { class: 'desc' }, ev.description) : null);
}

/* ---------- Besetzung */
function slotsCard(ev, repaint) {
  const p = ev.can_plan;
  const respOf = new Map(ev.responses.map((r) => [r.sub, r]));
  const head = h('div', { class: 'card-head' }, h('h3', null, 'Besetzung'), h('div', { class: 'spacer' }),
    p ? h('button', { class: 'btn sm', onclick: () => slotsDialog(ev, repaint) }, icon('edit'), 'Stellen') : null);
  if (!ev.slots.length) {
    return h('div', { class: 'card card-pad' }, head, h('div', { class: 'resp-empty' }, p ? 'Noch keine Stellen. Lege fest, wer gebraucht wird (z. B. Regie, 2× Kamera, Ton).' : 'Für diesen Termin sind noch keine Stellen festgelegt.'),
      p ? h('button', { class: 'btn primary', style: { marginTop: '12px' }, onclick: () => slotsDialog(ev, repaint) }, icon('plus'), 'Stellen festlegen') : null);
  }
  const rows = ev.slots.map((s) => {
    const people = s.assigned.map((a) => {
      const r = respOf.get(a.sub);
      const warn = r?.status === 'no';
      return h('span', { class: 'pill' + (a.sub === S.user.sub ? ' mine' : '') + (warn ? ' warn' : '') + (a.active ? '' : ' off'), title: warn ? `${a.name} hat abgesagt` : r ? `${a.name}: ${respText(r)}` : a.active ? a.email : `${a.name} hat keinen Zugriff mehr` },
        avatar(a, r?.status || 'none'), h('span', { class: 'nm' }, a.name),
        r?.status === 'later' && r.from_time ? h('small', { class: 'pt later' }, `ab ${r.from_time}`) : r?.status === 'online' ? h('small', { class: 'pt online' }, 'online') : null,
        p ? h('button', { class: 'x', title: 'Entfernen', 'aria-label': `${a.name} entfernen`, onclick: (e) => busy(e.currentTarget, async () => repaint(await del(`/api/events/${ev.id}/assign/${a.id}`))) }, icon('x')) : null);
    });
    const open = Array.from({ length: s.open }, (_, i) => (p
      ? h('button', { class: 'pill open', onclick: (e) => pickPerson(e.currentTarget, ev, s, repaint) }, icon('plus'), i === 0 ? 'Einteilen' : 'Offen')
      : h('span', { class: 'pill open' }, 'Offen')));
    return h('div', { class: 'slot' },
      h('div', { class: 'slot-name' }, h('b', null, s.name), h('small', { class: s.open ? 'miss' : 'full' }, `${s.assigned.length}/${s.needed}`)),
      h('div', { class: 'slot-people' }, people, open));
  });
  return h('div', { class: 'card card-pad' }, head, h('div', { class: 'slots' }, rows));
}

function pickPerson(anchor, ev, slot, repaint) {
  const taken = new Set(slot.assigned.map((a) => a.sub));
  const otherSlots = new Map();
  for (const s of ev.slots) for (const a of s.assigned) if (s.id !== slot.id) otherSlots.set(a.sub, [...(otherSlots.get(a.sub) || []), s.name]);
  const respOf = new Map(ev.responses.map((r) => [r.sub, r]));
  const search = input({ placeholder: 'Name suchen …', type: 'search' });
  const list = h('div', { class: 'picker-list' });
  const order = [['yes', 'Vor Ort'], ['later', 'Später'], ['online', 'Online'], [null, 'Keine Rückmeldung'], ['no', 'Kann nicht']];
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const people = (ev.people || []).filter((x) => !taken.has(x.sub) && (!q || x.name.toLowerCase().includes(q) || x.email.toLowerCase().includes(q)));
    const groups = order.map(([st, label]) => {
      const items = people.filter((x) => (x.response || null) === st)
        .sort((a, b) => Number(!!respOf.get(b.sub)?.wishes?.includes(slot.id)) - Number(!!respOf.get(a.sub)?.wishes?.includes(slot.id)) || a.name.localeCompare(b.name, 'de'));
      if (!items.length) return null;
      return [h('div', { class: 'picker-sec' }, `${label} · ${items.length}`), items.map((x) => {
        const r = respOf.get(x.sub);
        const wish = r?.wishes?.includes(slot.id);
        const sub = [r?.status === 'later' && r.from_time ? `ab ${r.from_time}` : '', otherSlots.has(x.sub) ? `schon: ${otherSlots.get(x.sub).join(', ')}` : '', r?.comment || '', x.kind === 'guest' ? 'Gast' : ''].filter(Boolean).join(' · ');
        return h('button', { class: 'picker-item' + (st === 'no' ? ' no' : ''), onclick: async () => {
          if (st === 'no' && !(await confirmDialog(`${x.name} hat für diesen Termin abgesagt. Trotzdem als ${slot.name} einteilen?`, { title: 'Trotzdem einteilen?', okLabel: 'Einteilen', danger: false }))) return;
          closePop();
          await busy(null, async () => repaint(await post(`/api/events/${ev.id}/assign`, { slot_id: slot.id, sub: x.sub })));
        } }, avatar(x, st || 'none'), h('span', { class: 't' }, h('b', null, x.name), sub ? h('small', null, sub) : null),
        wish ? h('span', { class: 'wish', title: `Wunsch: ${slot.name}` }, icon('star')) : h('span'));
      })];
    }).filter(Boolean);
    fill(list, groups.length ? groups : h('div', { class: 'resp-empty', style: { padding: '10px' } }, q ? 'Niemand gefunden.' : 'Alle sind schon eingeteilt.'));
  };
  search.addEventListener('input', paint);
  paint();
  popover(anchor, h('div', { class: 'picker' }, h('div', { class: 'picker-sec', style: { paddingTop: '2px' } }, `${slot.name} einteilen`), search, list));
  setTimeout(() => search.focus(), 20);
}

/* ---------- Rückmeldungen */
function responsesCard(ev, repaint) {
  const p = ev.can_plan;
  const by = { yes: [], later: [], online: [], no: [] };
  for (const r of ev.responses) by[r.status]?.push(r);
  const personRow = (x, st) => {
    const tag = p ? 'button' : 'div';
    return h(tag, { class: 'resp-person', type: p ? 'button' : null, onclick: p ? (e) => menu(e.currentTarget, [
      { section: x.name },
      ...Object.entries(RESP).map(([k, r]) => ({ label: `Eintragen: ${r.label}`, icon: r.icon, active: k === st,
        onClick: () => responseDialog(ev, k, { sub: x.sub, who: x.name, current: st ? x : null, onDone: repaint }) })),
      st ? { label: 'Rückmeldung entfernen', icon: 'trash', onClick: () => busy(null, async () => repaint(await put(`/api/events/${ev.id}/response`, { status: null, sub: x.sub }))) } : null,
    ]) : null },
    avatar(x, st || 'none'),
    h('span', { class: 't' }, h('span', null, x.name, x.kind === 'guest' ? h('small', null, ' · Gast') : null),
      st === 'later' && x.from_time ? h('small', { class: 'tm' }, `ab ${x.from_time} Uhr`) : null,
      x.wishes?.length ? h('small', null, '★ ' + x.wishes.map((id) => ev.slots.find((s) => s.id === id)?.name).filter(Boolean).join(', ')) : null,
      x.comment ? h('span', { class: 'c' }, x.comment) : null,
      x.by_planner ? h('small', null, 'von Planer eingetragen') : null));
  };
  const col = (st, label, ic, items) => h('div', { class: 'resp-col ' + (st || '') },
    h('h4', null, icon(ic), label, h('span', { class: 'n' }, items.length)),
    items.length ? items.map((x) => personRow(x, st)) : h('div', { class: 'resp-empty' }, '–'));
  return h('div', { class: 'card card-pad' }, h('div', { class: 'card-head' }, h('h3', null, 'Rückmeldungen')),
    h('div', { class: 'resp-cols' },
      Object.entries(RESP).map(([k, r]) => col(k, r.label, r.icon, by[k])),
      p ? col(null, 'Noch offen', 'clock', ev.no_answer || []) : null));
}

/* ---------- Rundown */
function rundownCard(ev, repaint) {
  const linked = S.status?.rundown?.linked;
  if (!linked || (!ev.rundown && !ev.can_plan)) return null;
  const body = h('div', { class: 'stack' });
  if (ev.rundown) {
    body.append(h('div', { class: 'rd-link' }, h('span', { class: 'mod-ico' }, icon('list')),
      h('span', { class: 't' }, h('b', null, ev.rundown.title), h('small', null, 'FF Rundown')),
      ev.rundown.link ? h('a', { class: 'btn sm', href: ev.rundown.link, target: '_blank', rel: 'noopener' }, icon('external'), 'Öffnen') : null));
    if (!ev.rundown.link) body.append(h('small', { class: 'hint' }, 'Du hast keinen Zugriff auf FF Rundown.'));
    if (ev.can_plan) body.append(h('div', { class: 'row' },
      S.status.rundown.api ? h('button', { class: 'btn sm', onclick: () => rundownDialog(ev, repaint) }, 'Ändern') : null,
      h('button', { class: 'btn sm ghost', onclick: (e) => busy(e.currentTarget, async () => repaint(await del(`/api/events/${ev.id}/rundown`))) }, 'Entfernen')));
  } else if (S.status.rundown.api) {
    body.append(h('p', { class: 'hint', style: { margin: 0 } }, 'Verknüpfe den Ablaufplan aus FF Rundown – vorhandenen auswählen oder gleich neu anlegen.'),
      h('button', { class: 'btn', onclick: () => rundownDialog(ev, repaint) }, icon('link'), 'Rundown hinterlegen'));
  } else {
    body.append(h('p', { class: 'hint', style: { margin: 0 } }, 'FF Rundown ist nur verlinkt. Zum Auswählen und Anlegen muss ein Admin RUNDOWN_API_SECRET eintragen.'));
  }
  return h('div', { class: 'card card-pad' }, h('div', { class: 'card-head' }, h('h3', null, 'Rundown')), body);
}

async function rundownDialog(ev, repaint) {
  const box = h('div', null, h('div', { class: 'resp-empty' }, 'Lädt Rundowns …'));
  const m = modal({ title: 'Rundown hinterlegen', body: box });
  let data;
  try { data = await get(`/api/events/${ev.id}/rundowns`); } catch (e) { return fill(box, h('div', { class: 'form-error' }, e.message)); }
  if (!data.user.found) return fill(box, h('div', { class: 'notice warn' }, icon('info'), 'Öffne FF Rundown einmal über das Portal – danach kannst du hier Rundowns auswählen und anlegen.'));
  const title = input({ value: ev.title, maxlength: 200 });
  const rows = [...data.rundowns].sort((a, b) => Math.abs(new Date(a.event_date || '2100-01-01') - new Date(ev.date)) - Math.abs(new Date(b.event_date || '2100-01-01') - new Date(ev.date)));
  fill(box,
    data.user.can_create ? h('div', { class: 'card card-pad', style: { marginBottom: '16px', padding: '14px' } },
      field('Neuen Rundown anlegen', title, `Mit Datum ${fmtShort(ev.date)}${ev.start_time ? ' und Start ' + ev.start_time : ''}.`),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.currentTarget, async () => { repaint(await post(`/api/events/${ev.id}/rundown`, { title: title.value })); m.close(); toast('Rundown angelegt und hinterlegt', 'ok'); }) }, icon('plus'), 'Anlegen und hinterlegen')) : null,
    h('div', { class: 'section-title', style: { marginTop: 0 } }, 'Vorhandenen auswählen'),
    rows.length ? h('div', { class: 'rd-choose' }, rows.map((r) => h('button', { onclick: (e) => busy(e.currentTarget, async () => { repaint(await put(`/api/events/${ev.id}/rundown`, { rundown_id: r.id })); m.close(); }) },
      h('span', null, r.title), h('small', null, r.event_date ? fmtShort(r.event_date) : '–'))))
      : h('div', { class: 'resp-empty' }, 'Keine Rundowns, auf die du Zugriff hast.'));
}

function logCard(ev) {
  if (!ev.log?.length) return null;
  const TXT = { created: 'angelegt', edited: 'bearbeitet', status: 'Status', assigned: 'eingeteilt', unassigned: 'entfernt', rundown: 'Rundown', response_for: 'Rückmeldung eingetragen' };
  const ST = { draft: 'Entwurf', open: 'freigegeben', closed: 'Abfrage beendet', cancelled: 'abgesagt' };
  const d = h('details', null, h('summary', { style: { cursor: 'pointer', color: 'var(--text-2)', fontSize: '13.5px' } }, `Verlauf (${ev.log.length})`),
    h('div', { class: 'log', style: { marginTop: '10px' } }, ev.log.map((l) => h('div', null, h('span', { class: 't' }, fmtAgo(l.at)),
      h('span', null, h('b', null, l.by || '–'), ' · ', TXT[l.action] || l.action, l.detail ? ': ' + (l.action === 'status' ? ST[l.detail] || l.detail : l.detail) : '')))));
  return h('div', { class: 'card card-pad' }, d);
}

/* ------------------------------------------------------------ Dialoge */
async function positions() {
  if (!S.positions) S.positions = (await get('/api/positions')).positions;
  return S.positions;
}

function slotEditor(initial) {
  const rows = initial.map((s) => ({ ...s }));
  const box = h('div');
  const paint = async () => {
    const pos = (await positions()).filter((p) => p.active);
    fill(box,
      h('div', { class: 'pos-quick' }, pos.map((p) => h('button', { type: 'button', onclick: () => {
        const ex = rows.find((r) => r.position_id === p.id || r.name.toLowerCase() === p.name.toLowerCase());
        if (ex) ex.needed = Math.min(50, ex.needed + 1); else rows.push({ name: p.name, position_id: p.id, needed: 1 });
        paint();
      } }, icon('plus'), p.name)),
      h('button', { type: 'button', onclick: () => { rows.push({ name: '', position_id: null, needed: 1 }); paint().then(() => box.querySelector('.slot-edit-row:last-child input')?.focus()); } }, icon('plus'), 'Andere …')),
      rows.length ? h('div', { class: 'slot-edit' }, rows.map((r, i) => {
        const name = input({ value: r.name, placeholder: 'Name der Stelle', maxlength: 60 });
        name.addEventListener('input', () => { r.name = name.value; if (r.position_id && pos.find((p) => p.id === r.position_id)?.name !== name.value) r.position_id = null; });
        const num = h('input', { value: String(r.needed), inputmode: 'numeric' });
        num.addEventListener('change', () => { r.needed = Math.max(1, Math.min(50, parseInt(num.value, 10) || 1)); num.value = r.needed; });
        return h('div', { class: 'slot-edit-row' }, name,
          h('div', { class: 'num' }, h('button', { type: 'button', onclick: () => { r.needed = Math.max(1, r.needed - 1); num.value = r.needed; } }, '−'), num, h('button', { type: 'button', onclick: () => { r.needed = Math.min(50, r.needed + 1); num.value = r.needed; } }, '+')),
          h('button', { type: 'button', class: 'icon-btn', title: 'Entfernen', 'aria-label': 'Stelle entfernen', onclick: () => { rows.splice(i, 1); paint(); } }, icon('trash')));
      })) : h('div', { class: 'resp-empty', style: { marginBottom: '10px' } }, 'Noch keine Stellen – oben antippen, um sie hinzuzufügen.'));
  };
  paint();
  return { el: box, value: () => rows.filter((r) => r.name.trim()).map((r) => ({ id: r.id, name: r.name.trim(), position_id: r.position_id || null, needed: r.needed })) };
}

function slotsDialog(ev, repaint) {
  const ed = slotEditor(ev.slots.map((s) => ({ id: s.id, name: s.name, position_id: s.position_id, needed: s.needed })));
  const err = h('div', { class: 'form-error' });
  modal({ title: 'Stellen festlegen', body: h('div', null, h('p', { class: 'hint', style: { marginTop: 0 } }, 'Wer wird gebraucht? Eine entfernte Stelle nimmt ihre Einteilungen mit.'), ed.el, err),
    actions: [{ label: 'Abbrechen', class: 'ghost' }, { label: 'Speichern', class: 'primary', onClick: async () => {
      try { repaint(await patch(`/api/events/${ev.id}`, { slots: ed.value() })); } catch (e) { err.textContent = e.message; return false; }
    } }] });
}

async function eventForm(ev = null) {
  const v = ev || {};
  const f = {
    title: input({ value: v.title || '', required: true, maxlength: 120, placeholder: 'z. B. FrankenFinals Finale' }),
    date: input({ type: 'date', value: v.date || '', required: true }),
    start_time: input({ type: 'time', value: v.start_time || '' }),
    end_time: input({ type: 'time', value: v.end_time || '' }),
    meet_time: input({ type: 'time', value: v.meet_time || '' }),
    location: input({ value: v.location || '', maxlength: 200, placeholder: 'Ort / Halle' }),
    respond_until: input({ type: 'date', value: v.respond_until || '' }),
    description: h('textarea', { class: 'input', rows: 4, maxlength: 4000, placeholder: 'Infos für die Crew (Ablauf, Anfahrt, Kleidung …)' }, v.description || ''),
  };
  const ed = ev ? null : slotEditor([]);
  const err = h('div', { class: 'form-error' });
  const values = () => Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
  const save = async (status) => {
    err.textContent = '';
    try {
      if (ev) { await patch(`/api/events/${ev.id}`, values()); m.close(); render(); toast('Gespeichert', 'ok'); }
      else { const r = await post('/api/events', { ...values(), status, slots: ed.value() }); m.close(); location.hash = `#/termin/${r.id}`; toast(status === 'open' ? 'Termin freigegeben' : 'Entwurf gespeichert', 'ok'); }
    } catch (e) { err.textContent = e.message; }
  };
  const body = h('div', null,
    field('Titel', f.title),
    h('div', { class: 'form-grid' }, field('Datum', f.date), field('Ort', f.location)),
    h('div', { class: 'form-grid three' }, field('Treffen / Aufbau', f.meet_time), field('Beginn', f.start_time), field('Ende', f.end_time)),
    field('Beschreibung', f.description),
    field('Rückmeldung bis', f.respond_until, 'Optional. Danach können nur noch Planer Rückmeldungen ändern.'),
    ed ? h('div', null, h('div', { class: 'section-title', style: { marginTop: '8px' } }, 'Stellen'), ed.el) : null,
    err);
  const m = modal({ title: ev ? 'Termin bearbeiten' : 'Neuer Termin', body, wide: true });
  m.el.append(h('div', { class: 'modal-foot' + (ev ? '' : ' split') },
    h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Abbrechen'),
    ev ? h('button', { class: 'btn primary', onclick: (e) => busy(e.currentTarget, () => save()) }, 'Speichern')
      : h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, () => save('draft')) }, 'Als Entwurf speichern'),
        h('button', { class: 'btn primary', onclick: (e) => busy(e.currentTarget, () => save('open')) }, 'Speichern & freigeben'))));
}

function duplicateDialog(ev) {
  const date = input({ type: 'date', value: ev.date, required: true });
  const title = input({ value: ev.title, maxlength: 120 });
  modal({ title: 'Termin kopieren', body: h('div', null, h('p', { class: 'hint', style: { marginTop: 0 } }, 'Übernimmt Zeiten, Ort, Beschreibung und Stellen – ohne Rückmeldungen und Einteilungen. Die Kopie ist ein Entwurf.'), field('Titel', title), field('Datum', date)),
    actions: [{ label: 'Abbrechen', class: 'ghost' }, { label: 'Kopieren', class: 'primary', onClick: async () => {
      try { const r = await post(`/api/events/${ev.id}/duplicate`, { date: date.value, title: title.value }); location.hash = `#/termin/${r.id}`; } catch (e) { toast(e.message, 'err'); return false; }
    } }] });
}

/* ------------------------------------------------------------ Verwaltung */
async function adminPage(tab) {
  if (!planner()) { location.hash = '#/'; return; }
  tab = tab === 'stellen' ? 'stellen' : 'personen';
  const box = h('div', null, h('div', { class: 'empty' }, 'Lädt …'));
  shell('/verwaltung',
    h('div', { class: 'page-head' }, h('span', { class: 'label' }, 'TERMINPLANUNG'), h('h1', null, 'Verwaltung'),
      h('p', { class: 'sub' }, 'Personen kommen aus dem Portal: Wer dort das Modul „Terminplanung“ hat, steht hier und kann eingeteilt werden.')),
    h('div', { class: 'tabs' }, h('a', { href: '#/verwaltung', class: tab === 'personen' ? 'active' : '' }, icon('users'), 'Personen'), h('a', { href: '#/verwaltung/stellen', class: tab === 'stellen' ? 'active' : '' }, icon('list'), 'Stellen')),
    box);
  if (tab === 'stellen') return positionsAdmin(box);
  let data;
  try { data = await get('/api/people'); } catch (e) { return fill(box, h('div', { class: 'empty' }, e.message)); }
  const st = data.sync.status;
  const syncBtn = h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { const r = await post('/api/people/sync'); toast(`${r.count} Personen abgeglichen`, 'ok'); adminPage('personen'); }) }, icon('refresh'), 'Jetzt abgleichen');
  fill(box,
    h('div', { class: 'u-tools' },
      data.sync.enabled
        ? h('div', { class: 'notice' + (st && !st.ok ? ' warn' : ''), style: { flex: 1 } }, icon(st && !st.ok ? 'alert' : 'info'),
          st ? (st.ok ? `Mitgliederliste zuletzt abgeglichen: ${fmtAgo(st.at)} (${st.count} Personen). Automatisch alle ${data.sync.minutes} Minuten.` : `Abgleich fehlgeschlagen (${fmtAgo(st.at)}): ${st.error}`) : 'Noch nicht abgeglichen.')
        : h('div', { class: 'notice warn', style: { flex: 1 } }, icon('alert'), 'Kein Abgleich mit dem Portal (PORTAL_URL / PORTAL_SSO_SECRET fehlen). Es erscheinen nur Personen, die die Terminplanung schon geöffnet haben.'),
      data.sync.enabled ? syncBtn : null),
    h('div', { class: 'u-list' }, data.people.map((p) => h('div', { class: 'u-row' + (p.active ? '' : ' off') },
      h('span', { class: 'avatar' }, initials(p)),
      h('div', { class: 'u-who' }, h('b', null, p.name), h('span', null, p.email)),
      h('div', { class: 'u-meta' }, h('div', { class: 'chips' },
        h('span', { class: 'chip ' + (p.role === 'member' ? '' : 'accent') }, ROLE[p.role] || p.role),
        p.kind === 'guest' ? h('span', { class: 'chip amber' }, 'Gast') : null,
        p.has_rundown ? h('span', { class: 'chip' }, icon('list'), 'Rundown') : null,
        p.active ? null : h('span', { class: 'chip red' }, 'Kein Zugriff mehr'),
        p.last_seen ? null : h('span', { class: 'chip' }, 'noch nie geöffnet'))),
      h('div', { class: 'u-actions' })))),
    h('p', { class: 'hint', style: { marginTop: '16px' } }, 'Rollen vergibt ein Admin im Portal unter Benutzer → Module → Terminplanung.'));
}

async function positionsAdmin(box) {
  S.positions = null;
  const list = await positions().catch((e) => { fill(box, h('div', { class: 'empty' }, e.message)); return null; });
  if (!list) return;
  const admin = S.user.is_admin;
  const reload = () => { S.positions = null; adminPage('stellen'); };
  const move = async (i, d) => {
    const ids = list.map((p) => p.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    await busy(null, async () => { await post('/api/positions/order', { ids }); reload(); });
  };
  const add = input({ placeholder: 'Neue Stelle, z. B. Drohne', maxlength: 60 });
  const addIt = () => busy(null, async () => { if (!add.value.trim()) return; await post('/api/positions', { name: add.value }); reload(); });
  add.addEventListener('keydown', (e) => { if (e.key === 'Enter') addIt(); });
  fill(box,
    h('p', { class: 'hint', style: { marginTop: 0 } }, admin ? 'Vorlage für die Stellen eines Termins. Ausgeblendete Stellen stehen beim Anlegen nicht mehr zur Auswahl; bestehende Termine behalten ihre Stellen.' : 'Diese Liste kann ein Planer-Admin ändern.'),
    h('div', { class: 'pos-list' }, list.map((p, i) => h('div', { class: 'pos-row' + (p.active ? '' : ' off') },
      h('b', null, p.name, p.active ? null : h('span', { class: 'muted' }, ' · ausgeblendet')),
      admin ? h('div', { class: 'acts' },
        h('button', { class: 'icon-btn', title: 'Nach oben', disabled: i === 0, onclick: () => move(i, -1) }, icon('chevronUp')),
        h('button', { class: 'icon-btn', title: 'Nach unten', disabled: i === list.length - 1, onclick: () => move(i, 1) }, icon('chevronDown')),
        h('button', { class: 'icon-btn', title: 'Mehr', onclick: (e) => menu(e.currentTarget, [
          { label: 'Umbenennen', icon: 'edit', onClick: () => renamePosition(p, reload) },
          { label: p.active ? 'Ausblenden' : 'Wieder einblenden', icon: p.active ? 'eyeOff' : 'eye', onClick: () => busy(null, async () => { await patch(`/api/positions/${p.id}`, { active: !p.active }); reload(); }) },
          { sep: true },
          { label: 'Löschen', icon: 'trash', onClick: async () => { if (await confirmDialog(`„${p.name}“ aus der Liste löschen? Bestehende Termine behalten die Stelle.`, { title: 'Stelle löschen?' })) busy(null, async () => { await del(`/api/positions/${p.id}`); reload(); }); } },
        ]) }, icon('more'))) : null))),
    admin ? h('div', { class: 'add-row' }, add, h('button', { class: 'btn primary', onclick: addIt }, icon('plus'), 'Hinzufügen')) : null);
}

function renamePosition(p, reload) {
  const name = input({ value: p.name, maxlength: 60 });
  modal({ title: 'Stelle umbenennen', body: field('Name', name), actions: [{ label: 'Abbrechen', class: 'ghost' }, { label: 'Speichern', class: 'primary', onClick: async () => {
    try { await patch(`/api/positions/${p.id}`, { name: name.value }); reload(); } catch (e) { toast(e.message, 'err'); return false; }
  } }] });
}

/* ------------------------------------------------------------ Router */
async function render() {
  closePop();
  const path = location.hash.replace(/^#/, '') || '/';
  if (!S.user) return loginScreen();
  let m;
  if ((m = path.match(/^\/termin\/(\d+)$/))) return eventPage(Number(m[1]));
  if (path === '/vergangen') return eventsPage(true);
  if (path === '/offen') return openPage();
  if (path === '/meine') return minePage();
  if ((m = path.match(/^\/verwaltung(?:\/(\w+))?$/))) return adminPage(m[1]);
  return eventsPage(false);
}

/** Nicht angemeldet: über das Portal anmelden (und danach zurück zur aktuellen Seite) */
function loginScreen() {
  const login = S.status?.portal?.login;
  const next = location.hash && location.hash !== '#/' ? '/' + location.hash : '';
  if (login) {
    const href = login + (next ? '?next=' + encodeURIComponent(next) : '');
    authScreen(h('p', null, 'Die Terminplanung öffnest du über das Portal von FrankenFinals Broadcast.'),
      h('a', { class: 'btn primary', href }, 'Über das Portal anmelden'));
    if (!sessionStorage.getItem('ffpl.redirected')) { sessionStorage.setItem('ffpl.redirected', '1'); location.assign(href); }
    return;
  }
  authScreen(h('p', null, 'Die Anmeldung über das Portal ist noch nicht eingerichtet. Ein Admin muss PORTAL_URL und PORTAL_SSO_SECRET setzen.'));
}

async function logout() {
  let r;
  try { r = await post('/api/logout'); } catch { /* */ }
  S.user = null;
  sessionStorage.setItem('ffpl.redirected', '1'); // nicht sofort wieder anmelden
  if (r?.portal) { location.href = r.portal + '/'; return; }
  render();
}

async function start() {
  try { S.status = await get('/api/status'); S.user = S.status.user; }
  catch (e) { return authScreen(h('p', null, e.message)); }
  if (S.user) sessionStorage.removeItem('ffpl.redirected');
  render();
}

window.addEventListener('hashchange', () => render());
window.addEventListener('ffpl:logout', () => { if (S.user) { S.user = null; start(); } });
start();
