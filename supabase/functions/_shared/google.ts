// Google Sheets through Merchforce's service account. The vendor shares their
// sheet (Editor, for write-back) with SERVICE_EMAIL; nothing else is needed.

type SA = { client_email: string; private_key: string; token_uri: string };
let cached: { token: string; exp: number } | null = null;

function account(): SA {
  return JSON.parse(atob(Deno.env.get('GOOGLE_SERVICE_ACCOUNT') ?? ''));
}

export const SERVICE_EMAIL = (() => { try { return account().client_email; } catch { return ''; } })();

const b64u = (b: Uint8Array | string) =>
  btoa(typeof b === 'string' ? b : String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function token(): Promise<string> {
  if (cached && cached.exp > Date.now() / 1000 + 60) return cached.token;
  const sa = account();
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: sa.token_uri, iat: now, exp: now + 3600 }));
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const res = await fetch(sa.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + b64u(sig) }) });
  const t = await res.json();
  if (!t.access_token) throw new Error('Google sign-in failed: ' + (t.error_description || t.error));
  cached = { token: t.access_token, exp: now + (t.expires_in ?? 3600) };
  return cached.token;
}

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + path, {
    ...init, headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 403 || res.status === 404) {
      throw new Error(`Cannot open that sheet. Check the link, and share it (Editor) with ${SERVICE_EMAIL}`);
    }
    throw new Error('Google Sheets ' + res.status + ': ' + (body.error?.message ?? 'error'));
  }
  return body;
}

export function sheetId(v: string): string {
  const m = String(v || '').match(/\/d\/([A-Za-z0-9_-]{20,})/);
  return m ? m[1] : String(v || '').trim();
}

const q = (tab: string) => "'" + tab.replace(/'/g, "''") + "'";

export async function meta(id: string): Promise<{ title: string; tabs: { name: string; sheetId: number }[] }> {
  const m = await api(id + '?fields=properties.title,sheets.properties(title,sheetId)');
  return { title: m.properties.title, tabs: m.sheets.map((s: any) => ({ name: s.properties.title, sheetId: s.properties.sheetId })) };
}

/** Rows (header first) of several tabs, raw values, first 30 columns. */
export async function readTabs(id: string, tabs: string[]): Promise<Record<string, any[][]>> {
  if (!tabs.length) return {};
  const params = tabs.map((t) => 'ranges=' + encodeURIComponent(q(t) + '!A1:AD')).join('&');
  const r = await api(id + '/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&' + params);
  const out: Record<string, any[][]> = {};
  (r.valueRanges ?? []).forEach((vr: any, i: number) => { out[tabs[i]] = vr.values ?? []; });
  return out;
}

export async function writeCells(id: string, cells: { tab: string; a1: string; value: unknown }[]) {
  if (!cells.length) return;
  await api(id + '/values:batchUpdate', { method: 'POST', body: JSON.stringify({
    valueInputOption: 'RAW', data: cells.map((c) => ({ range: q(c.tab) + '!' + c.a1, values: [[c.value]] })) }) });
}

export async function batchUpdate(id: string, requests: unknown[]) {
  if (requests.length) await api(id + ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
}

export async function writeRange(id: string, tab: string, rows: unknown[][]) {
  await api(id + '/values:batchUpdate', { method: 'POST', body: JSON.stringify({
    valueInputOption: 'RAW', data: [{ range: q(tab) + '!A1', values: rows }] }) });
}

export function colA1(i: number): string {      // 0 → A, 26 → AA
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
