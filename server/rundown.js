// Verbindung zu FF Rundown: Rundowns einer Person auflisten und anlegen (Schnittstelle /api/ext/rundowns im Rundown).
// RUNDOWN_URL = Adresse von FF Rundown, RUNDOWN_API_SECRET = Schlüssel (im Rundown: PLANNER_API_SECRET).
// Der Rundown prüft dabei die Rechte der Person (über ihre E-Mail) – hier wird nichts freigegeben, was sie dort nicht darf.
import crypto from 'node:crypto';
import { normalizeBaseUrl, PORTAL } from './portal.js';

export const RUNDOWN = {
  url: normalizeBaseUrl(process.env.RUNDOWN_URL),
  secret: String(process.env.RUNDOWN_API_SECRET || '').trim(),
};
export const rundownLinked = () => !!RUNDOWN.url;
export const rundownApi = () => !!RUNDOWN.url && RUNDOWN.secret.length >= 32;

export const sign = (secret = RUNDOWN.secret, ts = Math.floor(Date.now() / 1000)) =>
  `Planner ${ts}.${crypto.createHmac('sha256', secret).update(`rundown-api:${ts}`).digest('base64url')}`;

/** Link zum Rundown: über das Portal (Anmeldung inklusive), sonst direkt */
export function rundownLink(id) {
  const p = `/#/rundown/${id}`;
  if (PORTAL.url) return `${PORTAL.url}/sso/rundown?next=${encodeURIComponent(p)}`;
  return RUNDOWN.url ? RUNDOWN.url + p : null;
}

class RundownError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function call(method, path, body) {
  if (!rundownApi()) throw new RundownError(503, 'FF Rundown ist nicht verbunden (RUNDOWN_URL / RUNDOWN_API_SECRET)');
  let r;
  try {
    r = await fetch(RUNDOWN.url + path, {
      method, headers: { Authorization: sign(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000),
    });
  } catch { throw new RundownError(502, 'FF Rundown ist gerade nicht erreichbar'); }
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new RundownError(r.status === 401 ? 502 : r.status, r.status === 401 ? 'FF Rundown lehnt die Anfrage ab – stimmt der Schlüssel?' : data?.error || `FF Rundown antwortet mit ${r.status}`);
  return data;
}

export const listFor = (email) => call('GET', `/api/ext/rundowns?email=${encodeURIComponent(email)}`);
export const getFor = (id, email) => call('GET', `/api/ext/rundowns/${Number(id)}?email=${encodeURIComponent(email)}`);
export const createFor = (email, { title, event_date, start_time }) => call('POST', '/api/ext/rundowns', { email, title, event_date, start_time });
