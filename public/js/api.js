// Dünner Wrapper um fetch – Sitzung läuft über das Cookie ffpl_session (Anmeldung über das Portal).
export async function api(method, url, body) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let r;
  try { r = await fetch(url, opt); } catch { throw new Error('Keine Verbindung zum Server'); }
  let data = null;
  try { data = await r.json(); } catch { /* leer */ }
  if (!r.ok) {
    const err = new Error(data?.error || `Fehler ${r.status}`);
    err.status = r.status;
    if (r.status === 401) window.dispatchEvent(new Event('ffpl:logout'));
    throw err;
  }
  return data;
}
export const get = (u) => api('GET', u);
export const post = (u, b = {}) => api('POST', u, b);
export const put = (u, b = {}) => api('PUT', u, b);
export const patch = (u, b = {}) => api('PATCH', u, b);
export const del = (u) => api('DELETE', u);

export const initials = (u) => (u.name || u.email || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase();

/* ---------- Datum & Zeit (Termine haben YYYY-MM-DD und HH:MM, ohne Zeitzone) */
const D = (iso) => new Date(iso + 'T12:00:00');
export const fmtDay = (iso) => D(iso).toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '');
export const fmtDayNum = (iso) => String(D(iso).getDate());
export const fmtMonShort = (iso) => D(iso).toLocaleDateString('de-DE', { month: 'short' }).replace('.', '');
export const fmtMonth = (iso) => D(iso).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
export const fmtLong = (iso) => D(iso).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const fmtShort = (iso) => (iso ? D(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–');
export const fmtAgo = (ms) => new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export function timeRange(e) {
  if (!e.start_time) return '';
  return e.end_time ? `${e.start_time}–${e.end_time} Uhr` : `ab ${e.start_time} Uhr`;
}
/** Tage bis zum Termin (0 = heute) */
export function daysUntil(iso) {
  const a = D(iso), b = new Date(); b.setHours(12, 0, 0, 0);
  return Math.round((a - b) / 86400000);
}
