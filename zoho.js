// Zoho Books API for the bookkeeping workspace. Zoho does not let web pages call its API, so every request goes
// through the CA Desk Suite extension (read-only Books API + the OAuth token endpoint).
let seq = 0;
export const zohoReady = () => document.documentElement.dataset.capmZoho === '1';
const DC = { in: ['accounts.zoho.in', 'www.zohoapis.in'], com: ['accounts.zoho.com', 'www.zohoapis.com'] };

function call(url, { method = 'GET', body = '', auth = '' } = {}) {
  if (!zohoReady()) return Promise.reject(new Error('Zoho Books works through the CA Desk Suite extension – update it (Settings → Update now) and reload this page.'));
  const id = `z${Date.now()}${++seq}`;
  return new Promise((ok, bad) => {
    const to = setTimeout(() => { window.removeEventListener('message', on); bad(new Error('Zoho did not answer in 60 seconds.')); }, 60000);
    function on(e) {
      if (e.source !== window || e.data?.type !== 'CAPM_ZOHO_RES' || e.data.id !== id) return;
      clearTimeout(to); window.removeEventListener('message', on);
      if (!e.data.ok) return bad(new Error(e.data.error || 'Zoho request failed'));
      let j; try { j = JSON.parse(e.data.text); } catch { return bad(new Error(`Zoho replied ${e.data.status}: ${String(e.data.text).slice(0, 160)}`)); }
      ok({ status: e.data.status, json: j });
    }
    window.addEventListener('message', on);
    window.postMessage({ type: 'CAPM_ZOHO', id, url, method, body, auth }, location.origin);
  });
}
const form = o => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

// one-time: the code from Zoho API console → Self Client → Generate Code
export async function zohoExchange({ dc = 'in', clientId, clientSecret, code }) {
  const { json } = await call(`https://${DC[dc][0]}/oauth/v2/token`, { method: 'POST', body: form({ grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code }) });
  if (!json.refresh_token) throw new Error(json.error === 'invalid_code' ? 'The code has expired or was already used – generate a new one (it is valid for a few minutes).' : `Zoho: ${json.error || 'no refresh token returned'}`);
  return json.refresh_token;
}
const tokens = new Map();
async function access(cfg) {
  const k = cfg.clientId + cfg.refreshToken, t = tokens.get(k);
  if (t && t.until > Date.now() + 60000) return t.token;
  const { json } = await call(`https://${DC[cfg.dc || 'in'][0]}/oauth/v2/token`, { method: 'POST', body: form({ grant_type: 'refresh_token', client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken }) });
  if (!json.access_token) throw new Error(`Zoho sign-in failed: ${json.error || 'no access token'} – connect Zoho Books again.`);
  tokens.set(k, { token: json.access_token, until: Date.now() + (json.expires_in || 3600) * 1000 });
  return json.access_token;
}
export async function zohoGet(cfg, path, params = {}) {
  const q = new URLSearchParams({ ...(cfg.orgId ? { organization_id: cfg.orgId } : {}), ...params });
  for (let attempt = 0; attempt < 3; attempt++) {
    const { status, json } = await call(`https://${DC[cfg.dc || 'in'][1]}/books/v3/${path}?${q}`, { auth: `Zoho-oauthtoken ${await access(cfg)}` });
    if (status === 429) { await new Promise(r => setTimeout(r, 15000)); continue; }   // 100 requests a minute
    if (status === 401) { tokens.clear(); continue; }
    if (json.code && json.code !== 0) throw new Error(`Zoho Books: ${json.message || json.code}`);
    return json;
  }
  throw new Error('Zoho Books is busy – try again in a minute.');
}
export async function zohoOrgs(cfg) { return (await zohoGet({ ...cfg, orgId: '' }, 'organizations')).organizations || []; }
// all pages of a list (invoices, creditnotes, customerpayments) between two dates
export async function zohoList(cfg, what, from, to, onPage = () => {}) {
  const out = [];
  for (let page = 1; page < 100; page++) {
    const j = await zohoGet(cfg, what, { date_start: from, date_end: to, per_page: 200, page });
    out.push(...(j[what] || []));
    onPage(out.length);
    if (!j.page_context?.has_more_page) break;
  }
  return out;
}
