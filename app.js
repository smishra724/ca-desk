import { firebaseConfig } from './firebase-config.js';
import { PORTALS, portalByKey } from './portals.js';
import { extractFromFile, toISO, STATE_CODES } from './extract.js';
import { dueItems, fmtDate, regsOf, activeRegs, filingFor, isItrOnly, codeOf } from './compliance.js';
import { initTasks } from './tasks.js';
import { initSend } from './send.js';
import { initDriveImport } from './drive-import.js';

// Local mode (no login, data in this browser) until firebase-config.js has real keys.
const LOCAL = !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('PASTE');
const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const M = LOCAL ? await import('./local-db.js')
  : Object.assign({}, ...(await Promise.all(['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'].map(f => import(FB + f)))));
const {
  initializeApp, getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, sendPasswordResetEmail,
  getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc, collection, collectionGroup,
  getDocs, query, where, writeBatch, serverTimestamp, arrayUnion
} = M;

/* ================= setup ================= */
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
let secApp; // second app instance so creating a login doesn't sign the CA out
const secAuth = () => getAuth(secApp ||= initializeApp(firebaseConfig, 'secondary'));

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayISO = () => new Date().toISOString().slice(0, 10);
const isoToDisp = s => s ? s.split('-').reverse().join('-') : '';

const CONSTS = ['Proprietorship', 'Individual', 'HUF', 'Partnership Firm', 'LLP', 'Private Ltd', 'Public Ltd', 'OPC', 'Trust', 'Society', 'AOP/BOI'];
const DOC_CATS = ['GST Certificate', 'PAN Card', 'TAN Allotment', 'Aadhaar', 'Certificate of Incorporation', 'LLP Incorporation',
  'Partnership Deed / LLP Agreement', 'MOA / AOA', 'GST Return', 'ITR / Acknowledgement', 'Audit Report', 'Financial Statements',
  'TDS Return', 'ROC Filing', 'Other'];
const FIELDS = [
  ['code', 'Client code'], ['name', 'Legal name'], ['tradeName', 'Trade name'], ['constitution', 'Constitution', 'select', CONSTS],
  ['pan', 'PAN'], ['gstin', 'GSTIN'], ['tan', 'TAN'], ['cin', 'CIN / LLPIN'],
  ['doi', 'Date of birth / incorporation', 'date'], ['gstRegDate', 'GST registration date', 'date'],
  ['aadhaar', 'Aadhaar (proprietor)'], ['email', 'Email'], ['mobile', 'Mobile'],
  ['address', 'Address', 'textarea'], ['state', 'State'], ['pincode', 'PIN code'],
  ['gstFreq', 'GST filing', 'select', ['Monthly', 'QRMP', 'Composition', 'Not registered']],
  ['tds', 'TDS / TCS applicable', 'bool'], ['pfesic', 'PF / ESIC applicable', 'bool'],
  ['audit', 'Tax audit applicable', 'bool'], ['advTax', 'Advance tax applicable', 'bool'],
  ['people', 'Partners / directors (name, DIN)', 'textarea'], ['notes', 'Notes', 'textarea'],
];
// Which master fields apply to each constitution, and what they are called there.
// Fields not listed in `hide` are shown; `name` overrides the label.
const CONS_FORM = {
  'Individual': { hide: ['cin', 'people', 'tan'], name: { doi: 'Date of birth', aadhaar: 'Aadhaar' } },
  'Proprietorship': { hide: ['cin', 'people'], name: { doi: 'Date of birth (proprietor)', aadhaar: 'Aadhaar (proprietor)', name: 'Legal name (proprietor)' } },
  'HUF': { hide: ['cin'], name: { doi: 'Date of creation', aadhaar: 'Aadhaar (Karta)', people: 'Karta & coparceners' } },
  'Partnership Firm': { hide: ['cin', 'aadhaar'], name: { doi: 'Date of partnership deed', people: 'Partners (name, PAN, share %)' } },
  'LLP': { hide: ['aadhaar'], name: { cin: 'LLPIN', doi: 'Date of incorporation', people: 'Designated partners (name, DPIN)' } },
  'Private Ltd': { hide: ['aadhaar'], name: { cin: 'CIN', doi: 'Date of incorporation', people: 'Directors (name, DIN)' } },
  'Public Ltd': { hide: ['aadhaar'], name: { cin: 'CIN', doi: 'Date of incorporation', people: 'Directors (name, DIN)' } },
  'OPC': { hide: ['aadhaar'], name: { cin: 'CIN', doi: 'Date of incorporation', people: 'Director & nominee (name, DIN)' } },
  'Trust': { hide: ['aadhaar'], name: { cin: 'Registration no.', doi: 'Date of registration', people: 'Trustees' } },
  'Society': { hide: ['aadhaar'], name: { cin: 'Registration no.', doi: 'Date of registration', people: 'Governing body members' } },
  'AOP/BOI': { hide: ['aadhaar', 'cin'], name: { doi: 'Date of formation', people: 'Members' } },
};
const formFields = cons => {
  const r = CONS_FORM[cons]; if (!r) return FIELDS;
  return FIELDS.filter(f => !r.hide.includes(f[0])).map(f => r.name[f[0]] ? [f[0], r.name[f[0]], ...f.slice(2)] : f);
};
const label = k => (FIELDS.find(f => f[0] === k) || [k, k])[1];
const UPPER = new Set(['pan', 'gstin', 'tan', 'cin']);
// GST details live in the client's registrations list (one entry per GSTIN), not in the master form
const GST_KEYS = new Set(['gstin', 'gstRegDate', 'gstFreq']);
const GST_PORTALS = new Set(['gst', 'ewb', 'einv']);
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const stateOf = g => STATE_CODES[(g || '').slice(0, 2)] || '';
const regLabel = r => r ? `${r.state || stateOf(r.gstin) || 'GSTIN'} · ${r.gstin}` : '';
const newRegId = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
// fields stored on the client so lists/search work without opening each record
const regMirror = regs => {
  const act = regs.filter(r => r.gstin && r.status !== 'Cancelled');
  return { gstRegs: regs, gstins: regs.map(r => r.gstin).filter(Boolean), gstin: (act[0] || regs[0])?.gstin || '' };
};
function mergeReg(regs, r) {
  const i = regs.findIndex(x => x.gstin === r.gstin);
  if (i < 0) return [...regs, { id: newRegId(), status: 'Active', gstFreq: 'Monthly', ...r }];
  const out = [...regs]; const cur = out[i];
  for (const [k, v] of Object.entries(r)) if (v && !cur[k]) cur[k] = v; // fill blanks only
  return out;
}

const S = {
  setup: true, firm: '', profile: null, clients: [], view: 'dashboard', cid: null, client: null, tab: 'master',
  creds: [], docs: [], filings: {}, allFilings: {}, search: '', reveal: new Set(), pending: null, importRows: null,
  dashDays: 45,
};
const isAdmin = () => S.profile?.role === 'admin';
const extOn = () => document.documentElement.dataset.capmExt === '1';

function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms);
}
function modal(html) { $('#modalBox').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBox').innerHTML = ''; S.pending = null; }
function busy(on, msg = 'Working…') { const b = $('#busy'); b.textContent = msg; b.classList.toggle('show', on); }
async function guard(fn, okMsg) {
  try { busy(true); await fn(); if (okMsg) toast(okMsg); }
  catch (e) { console.error(e); toast(niceErr(e), 6000); }
  finally { busy(false); }
}
function niceErr(e) {
  const c = e?.code || '';
  if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found')) return 'Email or password is incorrect.';
  if (c.includes('email-already-in-use')) return 'This email already has a login. Use another email, or restore access from the list below.';
  if (c.includes('invalid-email')) return 'That email address is not complete — check it (for example name@gmail.com).';
  if (c.includes('weak-password')) return 'Password must be at least 6 characters.';
  if (c.includes('permission-denied')) return 'You do not have permission for this.';
  if (c.includes('too-many-requests')) return 'Too many attempts. Wait a few minutes and try again.';
  return e?.message || String(e);
}

/* ================= auth & boot ================= */
let settingUp = false;
onAuthStateChanged(auth, async u => { if (!settingUp) await boot(u); });

async function boot(u) {
  try {
    const s = await getDoc(doc(db, 'meta', 'setup'));
    S.setup = s.exists(); S.firm = s.exists() ? s.data().firmName || '' : ''; S.trackFrom = s.exists() ? s.data().trackFrom || '' : '';
  } catch { S.setup = true; }
  document.title = S.firm ? `${S.firm} · CA Desk` : 'CA Desk';
  if (!u) { S.profile = null; return renderLogin(); }
  const p = await getDoc(doc(db, 'users', u.uid)).catch(() => null);
  const role = p?.exists() ? p.data().role : null;
  if (role !== 'admin' && role !== 'client') return renderNoAccess(u);
  S.profile = { uid: u.uid, email: u.email, ...p.data() };
  if (isAdmin()) {
    if (!S.trackFrom) { S.trackFrom = todayISO(); updateDoc(doc(db, 'meta', 'setup'), { trackFrom: S.trackFrom }).catch(() => {}); }
    await loadClients(); await loadAllFilings(); await T.load(); loadGstLoginFlags(); S.view = 'dashboard'; autoTasks();
  }
  else { await openClient(S.profile.clientId, 'master'); await T.loadForClient(S.profile.clientId).catch(() => {}); }
  render();
}

function renderLogin() {
  $('#app').innerHTML = `
  <div class="auth-wrap"><div class="auth card">
    <div class="logo">₹</div>
    <h1>${esc(S.firm || 'CA Desk')}</h1>
    <p class="muted">Client compliance portal</p>
    <form data-form="login">
      <label>Email<input name="email" type="email" required autocomplete="username"></label>
      <label>Password<input name="pw" type="password" required autocomplete="current-password"></label>
      <button class="primary wide">Sign in</button>
    </form>
    <button class="wide gbtn" data-act="googleLogin"><svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg> Sign in with Google</button>
    <button class="link" data-act="forgot">Forgot password?</button>
    ${S.setup ? '' : `
    <hr><h3>First-time setup</h3>
    <p class="muted small">No firm is set up yet. Create the CA (owner) login. This can be done only once.</p>
    <form data-form="setup">
      <label>Firm name<input name="firm" required placeholder="e.g. Mishra & Associates"></label>
      <label>Your name<input name="name" required></label>
      <label>Email<input name="email" type="email" required></label>
      <label>Password<input name="pw" type="password" minlength="8" required></label>
      <button class="primary wide">Create owner login</button>
    </form>`}
  </div></div>`;
}
function renderNoAccess(u) {
  $('#app').innerHTML = `<div class="auth-wrap"><div class="auth card"><h1>No access</h1>
  <p>${esc(u.email)} is signed in but has no access to this portal. Contact your CA.</p>
  <button class="primary wide" data-act="logout">Sign out</button></div></div>`;
}

/* ================= data loading ================= */
async function loadClients() {
  const snap = await getDocs(collection(db, 'clients'));
  S.clients = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}
async function loadGstLoginFlags() {
  try {
    const snap = await getDocs(collectionGroup(db, 'credentials'));
    const has = new Set(); snap.forEach(d => { if (d.data().portal === 'gst') has.add(d.ref.parent.parent.id); });
    for (const c of S.clients) c._hasGstLogin = has.has(c.id);
  } catch {}
}
async function loadAllFilings() {
  S.allFilings = {};
  try {
    const snap = await getDocs(collectionGroup(db, 'filings'));
    snap.forEach(d => { S.allFilings[`${d.ref.parent.parent.id}|${d.id}`] = d.data(); });
  } catch (e) { console.warn('filings', e); }
}
async function openClient(cid, tab) {
  S.cid = cid; if (tab) S.tab = tab; S.reveal = new Set();
  const [c, cr, dc, fl] = await Promise.all([
    getDoc(doc(db, 'clients', cid)),
    getDocs(collection(db, 'clients', cid, 'credentials')),
    getDocs(collection(db, 'clients', cid, 'docs')),
    getDocs(collection(db, 'clients', cid, 'filings')),
  ]);
  S.client = c.exists() ? { id: c.id, ...c.data() } : { id: cid };
  S.creds = cr.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => PORTALS.findIndex(p => p.key === a.portal) - PORTALS.findIndex(p => p.key === b.portal) || (a.gstin || '').localeCompare(b.gstin || ''));
  S.docs = dc.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.uploadedAt?.seconds || 0) - (a.uploadedAt?.seconds || 0));
  S.filings = {}; fl.forEach(d => S.filings[d.id] = d.data());
  S.view = 'client';
}

/* ================= rendering ================= */
const NAV_ICON = {
  dashboard: '<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 4v4h6V4z"/>',
  due: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  tasks: '<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  clients: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2.2.6 3.5 2.7 3.5 6"/>',
  comps: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13l2 2 4-4"/>',
  import: '<path d="M12 3v12M7 10l5 5 5-5M4 19h16"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};
const PAGE_TITLE = { dashboard: 'Dashboard', due: 'Due dates', tasks: 'Tasks', task: 'Task', workflow: 'Work categories', clients: 'Clients', client: 'Client', comps: 'Compliances', import: 'Excel import', settings: 'Settings' };
function render() {
  if (!S.profile) return;
  const items = isAdmin() ? [['dashboard', 'Dashboard'], ['due', 'Due dates'], ['tasks', 'Tasks'], ['clients', 'Clients'], ['comps', 'Compliances'], ['import', 'Excel import'], ['settings', 'Settings']] : [];
  const active = v => S.view === v || (v === 'tasks' && ['task', 'workflow'].includes(S.view)) || (v === 'clients' && S.view === 'client');
  const nav = items.map(([v, l]) => `<button class="nav ${active(v) ? 'on' : ''}" data-act="go" data-v="${v}"><svg viewBox="0 0 24 24" aria-hidden="true">${NAV_ICON[v]}</svg><span>${l}</span></button>`).join('');
  const who = S.profile.name || S.profile.email || '';
  const ini = who.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  $('#app').innerHTML = `
  <div class="shell ${isAdmin() ? '' : 'noside'}">
    ${isAdmin() ? `<aside class="side">
      <div class="brand"><span class="logo sm">₹</span><span class="firm">${esc(S.firm || 'CA Desk')}</span></div>
      <nav>${nav}</nav>
      <div class="side-foot">${LOCAL ? '<span class="tag amber">Local mode</span>' : `<span class="avatar lg">${esc(ini)}</span><span class="side-who"><b>${esc(S.profile.name || 'Owner')}</b><small>${esc(S.profile.email)}</small></span><button class="ghost signout" data-act="logout" title="Sign out" aria-label="Sign out"><svg viewBox="0 0 24 24"><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/></svg></button>`}</div>
    </aside>` : ''}
    <div class="work">
      <header class="topbar">
        <h1 class="ptitle">${isAdmin() ? PAGE_TITLE[S.view] || '' : esc(S.firm || 'CA Desk')}</h1>
        ${isAdmin() ? `<div class="gsearch"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="gq" placeholder="Find a client by name, PAN or GSTIN" autocomplete="off" value="${esc(S.gq || '')}"><div id="gqres" class="gqres"></div></div>
          <button class="primary" data-act="fromDoc" data-mode="new">New client</button>`
          : `<button class="ghost" data-act="logout">Sign out</button>`}
      </header>
      ${LOCAL ? `<div class="localbar">Data is saved in this browser on this computer only. Take a backup from <a href="#" data-act="go" data-v="settings">Settings</a> regularly. Client and staff logins switch on once Firebase is connected.</div>` : ''}
      <main>${body()}</main>
    </div>
  </div>`;
}
function gqResults() {
  const box = $('#gqres'); if (!box) return;
  const q = (S.gq || '').trim().toLowerCase();
  if (q.length < 2) { box.innerHTML = ''; box.classList.remove('show'); return; }
  const hits = S.clients.filter(c => [c.name, c.tradeName, c.pan, c.code, ...(c.gstins || [])].some(v => (v || '').toLowerCase().includes(q))).slice(0, 8);
  box.innerHTML = hits.map(c => `<button data-act="gqOpen" data-id="${c.id}"><b>${esc(c.name)}</b><span>${esc(c.constitution || '')}${c.pan ? ` <code>${esc(c.pan)}</code>` : ''}</span></button>`).join('')
    || `<p class="muted small">No client matches "${esc(S.gq)}".</p>`;
  box.classList.add('show');
}
function body() {
  switch (S.view) {
    case 'dashboard': return vDashboard();
    case 'due': return vDue();
    case 'clients': return vClients();
    case 'client': return vClient();
    case 'import': return vImport();
    case 'settings': return vSettings();
    case 'comps': return vComps();
    case 'tasks': return T.vTasks();
    case 'task': return T.vTask();
    case 'workflow': return T.vWorkflow();
  }
  return '';
}

/* ---------- dashboard ---------- */
// Due items across all clients. Items due before the "track from" date are history (filed before CA Desk)
// and only appear on the Due dates page when "include history" is ticked.
const dayStart = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
function trackFrom() { return S.trackFrom ? new Date(S.trackFrom + 'T00:00') : dayStart(new Date()); }
function dueRows({ back = 0, ahead = 45, history = false } = {}) {
  const today = dayStart(new Date());
  const from = new Date(today); from.setDate(from.getDate() - back);
  const tf = trackFrom(); const start = history ? from : (from > tf ? from : tf);
  const to = new Date(today); to.setDate(to.getDate() + ahead);
  const rows = [];
  if (start > to) return rows;
  for (const c of S.clients) for (const it of dueItems(c, start, to)) {
    const f = filingFor(S.allFilings, it, `${c.id}|`);
    if (f?.status === 'filed') continue;
    if (it.note === 'Optional' && it.due < today) continue;
    rows.push({ ...it, c, overdue: it.due < today });
  }
  return rows.sort((a, b) => a.due - b.due || (a.c.name || '').localeCompare(b.c.name || ''));
}
const dashRows = () => dueRows({ back: 365, ahead: 0, history: true }); // used by bulk "mark filed"
const isoLocalD = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const baseForm = f => f.replace(/ — .*$/, '').replace(/ \(QRMP\)$/, '');
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ICON = {
  users: '<svg viewBox="0 0 24 24"><path d="M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0Zm-12 9c0-3 3.6-5 8-5s8 2 8 5"/></svg>',
  gst: '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4zM8 9h8M8 13h8M8 17h5"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 3 2 21h20L12 3Zm0 7v5m0 3v.01"/></svg>',
  task: '<svg viewBox="0 0 24 24"><path d="M9 11l2 2 4-4M5 4h14v16H5z"/></svg>',
};

function vDashboard() {
  const today = dayStart(new Date());
  const week = dueRows({ ahead: 7 }).filter(r => !r.overdue);
  const overdue = dueRows({ back: 365, ahead: 0 }).filter(r => r.overdue);
  const biz = S.clients.filter(c => c.constitution !== 'Individual');
  const regs = S.clients.flatMap(c => regsOf(c).filter(r => r.status !== 'Cancelled').map(r => ({ ...r, c })));
  const states = new Set(regs.map(r => r.state).filter(Boolean));
  const openTasks = S.tasks.filter(t => !['Completed', 'Cancelled'].includes(t.status));
  const hr = new Date().getHours();
  const hello = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const who = (S.profile.name || '').split(' ')[0];

  // this month's GST filing progress (returns due in the current calendar month)
  const mStart = new Date(today.getFullYear(), today.getMonth(), 1), mEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const prog = {};
  // every compliance due this month (GST, TDS, PF/ESIC, income tax, ROC…), plus earlier ones still pending since tracking began
  const tf = dayStart(new Date(S.trackFrom || mStart)), back = tf < mStart ? tf : mStart;
  for (const c of S.clients) for (const it of dueItems(c, back, mEnd)) {
    if (it.note === 'Optional') continue;
    const filed = filingFor(S.allFilings, it, `${c.id}|`)?.status === 'filed';
    if (it.due < mStart && filed) continue; // earlier months: only what is still pending
    const k = baseForm(it.form); const p = prog[k] ||= { total: 0, filed: 0, due: it.due, period: it.period, periods: new Set() };
    p.total++; if (filed) p.filed++; p.periods.add(it.period); if (it.due < p.due) p.due = it.due;
  }
  const progHtml = Object.entries(prog).sort((a, b) => a[1].due - b[1].due).filter(([, p]) => p.total).map(([k, p]) => {
    const pct = Math.round(p.filed / p.total * 100), late = p.due < today && p.filed < p.total;
    const left = p.total - p.filed;
    return `<div class="prog click" data-act="dueOpenForm" data-k="${esc(k)}" title="Show pending ${esc(k)}"><div class="prog-h"><b>${esc(k)}</b><span class="muted small">${p.periods.size > 1 ? p.periods.size + ' periods' : esc(p.period)} · due ${p.due.getDate()} ${MONS[p.due.getMonth()]}${p.due.getFullYear() !== today.getFullYear() ? ' ' + p.due.getFullYear() : ''}</span>
      <span class="prog-n ${late ? 'red' : ''}">${left ? `<span class="${late ? 'red' : ''}">${left} pending</span>` : '<span class="ok">All filed</span>'}<small class="muted"> ${p.filed}/${p.total}</small></span></div>
      <div class="bar big"><i style="width:${pct}%" class="${pct === 100 ? 'done' : late ? 'late' : ''}"></i></div></div>`;
  }).join('') || '<p class="muted small">Nothing due this month. 🎉</p>';

  // next 7 days grouped by date
  const byDay = {};
  for (const r of week) (byDay[r.due.toDateString()] ||= { d: r.due, forms: {} }).forms[baseForm(r.form)] = [...(byDay[r.due.toDateString()].forms[baseForm(r.form)] || []), r];
  const weekHtml = Object.values(byDay).map(({ d, forms }) => `<div class="day">
      <div class="day-date ${d - today === 0 ? 'today' : ''}"><b>${d.getDate()}</b><span>${MONS[d.getMonth()]}</span></div>
      <div class="day-body">${Object.entries(forms).map(([f, rs]) => `<div class="day-row"><span class="form-pill">${esc(f)}</span>
        <span class="small">${rs.slice(0, 4).map(r => `<a href="#" data-act="open" data-id="${r.c.id}" data-tab="compliance">${esc(r.c.tradeName || r.c.name)}</a>`).join(', ')}${rs.length > 4 ? ` <a href="#" data-act="go" data-v="due" class="muted">+${rs.length - 4} more</a>` : ''}</span></div>`).join('')}</div></div>`).join('')
    || '<div class="empty-state">🎉 Nothing due in the next 7 days.</div>';

  // clients mix
  const mix = {}; for (const c of S.clients) mix[c.constitution || 'Not set'] = (mix[c.constitution || 'Not set'] || 0) + 1;
  const mixMax = Math.max(...Object.values(mix), 1);
  const mixHtml = Object.entries(mix).sort((a, b) => b[1] - a[1]).map(([k, n]) =>
    `<div class="hbar click" data-act="mixOpen" data-k="${esc(k)}" title="Show ${esc(k)} clients"><span>${esc(k)}</span><div><i style="width:${Math.max(4, n / mixMax * 100)}%"></i></div><b>${n}</b></div>`).join('');

  // needs attention
  const noPan = S.clients.filter(c => !c.pan).length;
  const noLogin = regs.filter(r => !r.c._hasGstLogin).length;
  const attn = [
    overdue.length && [`${overdue.length} return(s) overdue since ${isoToDisp(S.trackFrom)}`, 'go" data-v="due', 'red'],
    noPan && [`${noPan} client(s) without PAN`, 'cliShow" data-v="nopan', 'amber'],
    openTasks.filter(t => t.due && t.due < todayISO()).length && [`${openTasks.filter(t => t.due && t.due < todayISO()).length} task(s) past due date`, 'go" data-v="tasks', 'red'],
  ].filter(Boolean);

  // the month at a glance: every day, with what falls due and how much is still open
  const mDays = mEnd.getDate(), dayMap = {};
  for (const c of S.clients) for (const it of dueItems(c, mStart, mEnd)) {
    if (it.note === 'Optional') continue;
    const d = it.due.getDate(), m = dayMap[d] ||= { total: 0, filed: 0, forms: {} };
    const filed = it.due < dayStart(new Date(S.trackFrom || mStart)) || filingFor(S.allFilings, it, `${c.id}|`)?.status === 'filed';
    m.total++; if (filed) m.filed++;
    const f = baseForm(it.form); m.forms[f] = (m.forms[f] || 0) + (filed ? 0 : 1);
  }
  const SHORT = f => ({ 'GSTR-1': 'R1', 'GSTR-3B': '3B', 'TDS/TCS payment': 'TDS', 'TDS/TCS returns': 'TDS-R', 'PMT-06 tax payment': 'PMT', 'EPF ECR & payment': 'PF', 'ESIC contribution': 'ESI',
    'Income tax return': 'ITR', 'MGT-7 / 7A (annual return)': 'MGT7', 'AOC-4 (financials)': 'AOC4', 'GSTR-9 annual return': 'R9', 'DIR-3 KYC (directors)': 'KYC', 'CMP-08': 'CMP8',
    'Tax audit report': '3CD', 'DPT-3': 'DPT3', 'LLP Form 8': 'LLP8', 'LLP Form 11': 'LLP11' })[f] || f.split(/[\s(]/)[0];
  const dTxt = n => `${n} ${MONS[today.getMonth()]}`;
  const strip = Array.from({ length: mDays }, (_, i) => {
    const d = i + 1, m = dayMap[d], dt = new Date(today.getFullYear(), today.getMonth(), d);
    const isT = d === today.getDate(), past = dt < today, wd = dt.getDay();
    const open = m ? m.total - m.filed : 0;
    const st = !m ? '' : open === 0 ? 'done' : past ? 'late' : 'due';
    const tip = m ? `${dTxt(d)}: ${Object.entries(m.forms).map(([f, n]) => `${f}${n ? ` (${n} pending)` : ' (all filed)'}`).join(', ')}` : dTxt(d);
    return `<button class="sday ${st} ${isT ? 'today' : ''} ${wd === 0 ? 'sun' : ''}" ${m ? `data-act="dueDay" data-d="${isoLocalD(dt)}"` : 'disabled'} title="${esc(tip)}">
      <span class="sd-w">${'SMTWTFS'[wd]}</span><b>${d}</b>${m ? `<span class="sd-f">${Object.keys(m.forms).slice(0, 2).map(SHORT).join(' ')}</span><span class="sd-n">${open || '✓'}</span>` : ''}</button>`;
  }).join('');
  const monthOpen = Object.values(dayMap).reduce((a, m) => a + m.total - m.filed, 0);
  const monthAll = Object.values(dayMap).reduce((a, m) => a + m.total, 0);
  const nextDue = week[0];
  const lead = overdue.length ? `${overdue.length} return${overdue.length === 1 ? '' : 's'} overdue. Clear these first.`
    : nextDue ? `Next up: ${baseForm(nextDue.form)} on ${dTxt(nextDue.due.getDate())} for ${new Set(week.filter(r => +r.due === +nextDue.due).map(r => r.c.id)).size} client(s).`
    : 'Nothing falls due in the next seven days.';

  return `
  <section class="hero2">
    <div class="h2-top">
      <div><p class="h2-date">${today.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
        <h2 class="h2-hello">${hello}${who ? ', ' + esc(who) : ''}</h2><p class="h2-lead">${esc(lead)}</p></div>
      <div class="h2-meter"><b>${monthAll - monthOpen}<small>/${monthAll}</small></b><span>returns filed in ${MONS[today.getMonth()]}</span>
        <div class="bar"><i style="width:${monthAll ? Math.round((monthAll - monthOpen) / monthAll * 100) : 0}%"></i></div></div>
    </div>
    <div class="strip" role="list" aria-label="Due dates this month" style="grid-template-columns:repeat(${mDays},minmax(30px,1fr))">${strip}</div>
    <div class="h2-key"><span><i class="k-due"></i>Due, open</span><span><i class="k-late"></i>Missed</span><span><i class="k-done"></i>All filed</span><span><i class="k-today"></i>Today</span><span class="muted">Click a date to see who is pending.</span></div>
  </section>
  <div class="kpis">
    <a href="#" class="kpi" data-act="go" data-v="clients"><i class="ic blue">${ICON.users}</i><div><b>${S.clients.length}</b><span>Clients</span><small>${biz.length} businesses, ${S.clients.length - biz.length} individuals</small></div></a>
    <a href="#" class="kpi" data-act="go" data-v="comps"><i class="ic green">${ICON.gst}</i><div><b>${regs.length}</b><span>Active GSTINs</span><small>across ${states.size} state${states.size === 1 ? '' : 's'}</small></div></a>
    <a href="#" class="kpi" data-act="go" data-v="due"><i class="ic amber">${ICON.clock}</i><div><b>${week.length}</b><span>Due in 7 days</span><small>for ${new Set(week.map(r => r.c.id)).size} client(s)</small></div></a>
    <a href="#" class="kpi ${overdue.length ? 'alert' : ''}" data-act="dueOverdue"><i class="ic ${overdue.length ? 'red' : 'green'}">${ICON.alert}</i><div><b>${overdue.length}</b><span>Overdue</span><small>since ${isoToDisp(S.trackFrom)}</small></div></a>
    <a href="#" class="kpi" data-act="go" data-v="tasks"><i class="ic violet">${ICON.task}</i><div><b>${openTasks.length}</b><span>Open tasks</span><small>${openTasks.filter(t => t.status === 'Waiting on client').length} waiting on client</small></div></a>
  </div>
  <div class="dash-grid">
    <div>
      <section class="card"><div class="row-between"><h2>Due this month</h2><button class="sm" data-act="go" data-v="due">Open due dates</button></div>${progHtml}</section>
      <section class="card"><div class="row-between"><h2>Next 7 days</h2></div><div class="days">${weekHtml}</div></section>
    </div>
    <div>
      ${attn.length ? `<section class="card attn"><h2>Needs attention</h2>${attn.map(([t, act, cls]) => `<a href="#" class="attn-row ${cls}" data-act="${act}">${esc(t)} <span>→</span></a>`).join('')}</section>` : ''}
      ${T.dashCard()}
      <section class="card"><h2>Client mix</h2>${mixHtml}</section>
    </div>
  </div>`;
}

/* ---------- due dates page ---------- */
function vDue() {
  const f = S.dueF ||= { range: '30', form: '', q: '', history: false };
  const open = S.dueOpen ||= new Set();
  if (f.form) { open.add(f.form); f.form = ''; } // links from the dashboard open that compliance
  const ahead = f.range === 'overdue' ? 0 : +f.range;
  let rows = dueRows({ back: 365, ahead: S.dueDay ? 62 : ahead, history: f.history });
  if (S.dueDay) rows = rows.filter(r => isoLocalD(r.due) === S.dueDay);
  else if (f.range === 'overdue') rows = rows.filter(r => r.overdue);
  const allOpen = open.has('*');
  const q = f.q.toLowerCase(); if (q) rows = rows.filter(r => [r.c.name, r.c.tradeName, r.gstin, r.form].some(v => (v || '').toLowerCase().includes(q)));
  const consList = [...new Set(rows.map(r => r.c.constitution || 'Not set'))].sort();
  if (f.ctype) rows = rows.filter(r => f.ctype === 'itr' ? isItrOnly(r.c) : !isItrOnly(r.c));
  if (f.cons) rows = rows.filter(r => (r.c.constitution || 'Not set') === f.cons);
  // one button per compliance, ordered by its earliest due date
  const groups = new Map();
  for (const r of rows) { const k = baseForm(r.form); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const list = [...groups.entries()].map(([name, rs]) => ({ name, rs, clients: new Set(rs.map(r => r.c.id)).size, od: rs.filter(r => r.overdue).length, first: rs[0].due }))
    .sort((x, y) => x.first - y.first || x.name.localeCompare(y.name));
  const today = dayStart(new Date());
  const days = d => { const n = Math.round((d - today) / 864e5); return n < 0 ? `${-n} day${n === -1 ? '' : 's'} overdue` : n === 0 ? 'due today' : `in ${n} day${n === 1 ? '' : 's'}`; };
  const panel = g => `<div class="cpanel">${isAdmin() ? `<div class="cp-bar"><button class="sm" data-act="remindAll" data-k="${esc(g.name)}">${WA_ICON} Remind all ${g.clients} pending client${g.clients === 1 ? '' : 's'}</button></div>` : ''}<table class="tbl"><thead><tr><th>Client</th><th>Period</th><th>Due</th>${isAdmin() ? '<th>Task status</th>' : ''}<th></th></tr></thead><tbody>
    ${g.rs.map(r => `<tr class="${r.overdue ? 'od' : ''}">
      <td><a href="#" data-act="open" data-id="${r.c.id}" data-tab="compliance">${esc(r.c.name)}</a>${r.gstin ? `<div class="muted tiny"><span class="mono">${esc(r.gstin)}</span>${r.c.tradeName ? ' · ' + esc(r.c.tradeName) : ''}</div>` : r.c.tradeName ? `<div class="muted tiny">${esc(r.c.tradeName)}</div>` : ''}${r.note ? ` <span class="tag">${esc(r.note)}</span>` : ''}</td>
      <td>${esc(r.period)}</td><td class="nowrap">${fmtDate(r.due)}<div class="tiny ${r.overdue ? 'red' : 'muted'}">${days(r.due)}</div></td>
      ${isAdmin() ? `<td class="nowrap tstat">${T.statusSelect(r)}</td>` : ''}
      <td class="nowrap">${isAdmin() ? `${remindBtns(r.c.id, r.key)} <button class="sm" data-act="markFiled" data-cid="${r.c.id}" data-key="${r.key}">Mark filed</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
  return `
  <section class="card">
    <div class="row-between wrap"><h2>Due dates <span class="muted">(${rows.length} pending · ${list.length} compliance${list.length === 1 ? '' : 's'})</span></h2>
      <div class="btns">${list.length ? `<button class="sm" data-act="dueAll" data-v="${open.size ? '' : '1'}">${open.size ? 'Collapse all' : 'Expand all'}</button>` : ''}${isAdmin() ? '<button class="sm" data-act="bulkFiled">Mark past returns as filed…</button>' : ''}</div></div>
    <div class="filters">
      <select data-change="dueF" data-k="range">${[['overdue', 'Overdue only'], ['7', 'Next 7 days'], ['30', 'Next 30 days'], ['90', 'Next 90 days']].map(([v, l]) => `<option value="${v}" ${v === f.range ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input id="dueQ" placeholder="Search client or GSTIN…" value="${esc(f.q)}">
      <select data-change="dueF" data-k="ctype"><option value="">All clients</option><option value="business" ${f.ctype === 'business' ? 'selected' : ''}>Business clients</option><option value="itr" ${f.ctype === 'itr' ? 'selected' : ''}>Individual – ITR only</option></select>
      <select data-change="dueF" data-k="cons"><option value="">All constitutions</option>${consList.map(k => `<option ${k === f.cons ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select>
      <label class="chk"><input type="checkbox" data-change="dueF" data-k="history" ${f.history ? 'checked' : ''}> Include returns due before ${isoToDisp(S.trackFrom)}</label>
    </div>
    <p class="muted small">Tracking compliance from <b>${isoToDisp(S.trackFrom)}</b>. Returns due earlier are treated as filed before CA Desk. ${isAdmin() ? '<a href="#" data-act="setTrackFrom">Change</a>' : ''}</p>
    <div class="clist">
    ${S.dueDay ? `<div class="fchip">Showing returns due on <b>${isoToDisp(S.dueDay)}</b> <a href="#" data-act="dueDayClear">✕ show all</a></div>` : ''}
    ${list.map(g => `<div class="citem ${open.has(g.name) || allOpen ? 'open' : ''} ${g.od ? 'has-od' : ''}">
      <button class="chead" data-act="dueToggle" data-k="${esc(g.name)}">
        <span class="cname">${esc(g.name)}</span>
        <span class="ccount"><b>${g.clients}</b> client${g.clients === 1 ? '' : 's'} pending${g.rs.length > g.clients ? ` <span class="muted">(${g.rs.length} returns)</span>` : ''}</span>
        <span class="cdue">${g.od ? `<span class="tag red">${g.od} overdue</span>` : `next ${fmtDate(g.first)}`}</span>
        <span class="chev">▾</span>
      </button>
      ${open.has(g.name) || allOpen ? panel(g) : ''}
    </div>`).join('') || '<p class="muted empty">Nothing pending. 🎉</p>'}
    </div>
    <p class="muted small">Statutory due dates. Check CBIC / CBDT / MCA notifications for extensions.</p>
  </section>`;
}

/* ---------- clients list ---------- */
const itrFy = () => { const t = new Date(); return t.getMonth() >= 3 ? t.getFullYear() - 1 : t.getFullYear() - 2; }; // FY of the latest ITR due
function vClients() {
  const tab = S.clientTab ||= 'business';
  const q = S.search.toLowerCase();
  const itr = S.clients.filter(isItrOnly), biz = S.clients.filter(c => !isItrOnly(c));
  const cf = S.consF; // set from the dashboard's client mix: one constitution, across both tabs
  let base = cf ? S.clients.filter(c => (c.constitution || 'Not set') === cf) : tab === 'itr' ? itr : biz;
  const stF = S.stateF || '', shF = S.showF || '';
  const statesAll = [...new Set(base.flatMap(c => [c.state, ...regsOf(c).map(r => r.state)]).filter(Boolean))].sort();
  if (stF) base = base.filter(c => c.state === stF || regsOf(c).some(r => r.state === stF));
  if (shF) base = base.filter(c => ({ gst: regsOf(c).length > 0, nogst: !regsOf(c).length, nopan: !c.pan, nocontact: !c.mobile && !c.email, nologin: !(c.portalUsers || []).some(p => !p.revoked) })[shF]);
  const list = base.filter(c => !q || [c.name, c.tradeName, c.pan, c.gstin, c.code, c.mobile, c.email, ...(c.gstins || []), ...regsOf(c).map(r => r.state)].some(v => (v || '').toLowerCase().includes(q)));
  const sel = S.sel ||= new Set();
  const fy = itrFy(), fyL = `FY ${fy}-${String(fy + 1).slice(2)}`;
  const itrStatus = c => { const f = S.allFilings[`${c.id}|ITR-${fy}`]; return f?.status === 'filed' ? `<span class="tag green">Filed${f.filedOn ? ' ' + isoToDisp(f.filedOn) : ''}</span>` : '<span class="tag amber">Pending</span>'; };
  const cb = c => isAdmin() ? `<td class="cbx" data-stop="1"><input type="checkbox" data-change="selClient" value="${c.id}" ${sel.has(c.id) ? 'checked' : ''}></td>` : '';
  const filedCount = itr.filter(c => S.allFilings[`${c.id}|ITR-${fy}`]?.status === 'filed').length;
  const tv = cf ? 'business' : tab;
  const head = tv === 'itr'
    ? `<tr>${isAdmin() ? '<th class="cbx"><input type="checkbox" data-change="selAll"></th>' : ''}<th>Name</th><th>PAN</th><th>Date of birth</th><th>Mobile / email</th><th>ITR ${fyL}</th><th></th></tr>`
    : `<tr>${isAdmin() ? '<th class="cbx"><input type="checkbox" data-change="selAll"></th>' : ''}<th>Code</th><th>Name</th><th>Constitution</th><th>PAN</th><th>GSTIN</th><th>Client login</th></tr>`;
  const row = c => tv === 'itr'
    ? `<tr class="click" data-act="open" data-id="${c.id}">${cb(c)}<td><b>${esc(c.name || '—')}</b></td><td class="mono">${esc(c.pan) || '<span class="tag amber">No PAN</span>'}</td>
        <td class="nowrap">${isoToDisp(c.doi)}</td><td class="small">${esc(c.mobile)}${c.email ? `<div class="muted tiny">${esc(c.email)}</div>` : ''}</td><td>${itrStatus(c)}</td>
        <td class="nowrap" data-stop="1">${isAdmin() && S.allFilings[`${c.id}|ITR-${fy}`]?.status !== 'filed' ? `<button class="sm" data-act="markFiled" data-cid="${c.id}" data-key="ITR-${fy}">Mark filed</button>` : ''}</td></tr>`
    : `<tr class="click" data-act="open" data-id="${c.id}">${cb(c)}<td>${esc(c.code)}</td>
        <td><b>${esc(c.name || '—')}</b>${cf && isItrOnly(c) ? ' <span class="tag">ITR only</span>' : ''}${c.tradeName ? `<div class="muted small">${esc(c.tradeName)}</div>` : ''}</td>
        <td>${esc(c.constitution)}</td><td class="mono">${esc(c.pan)}</td><td class="mono">${esc(regsOf(c)[0]?.gstin || '')}${regsOf(c).length > 1 ? ` <span class="tag blue">+${regsOf(c).length - 1} more</span>` : ''}</td>
        <td>${(c.portalUsers || []).filter(p => !p.revoked).length ? '<span class="tag green">Active</span>' : '<span class="tag">—</span>'}</td></tr>`;
  const nSel = [...sel].filter(id => base.some(c => c.id === id)).length;
  return `
  <section class="card">
    <div class="row-between wrap">
      <h2>Clients <span class="muted">(${S.clients.length})</span></h2>
      <div class="btns">
        <button class="primary" data-act="fromDoc" data-mode="new">+ New client from documents</button>
        <button data-act="newClient" data-cat="${tab}">+ Blank client</button>
        <button data-act="driveOpen">Import from Google Drive</button>
        ${LOCAL ? '' : '<label class="filebtn ghostbtn">Attach documents from folder<input type="file" webkitdirectory multiple data-change="folderAttach"></label>'}
        <button data-act="exportAll">Export all (Excel)</button>
      </div>
    </div>
    <div class="tabs inner seg">
      <button class="${tab === 'business' && !cf ? 'on' : ''}" data-act="clientTab" data-t="business">Business clients <span class="cnt">${biz.length}</span></button>
      <button class="${tab === 'itr' && !cf ? 'on' : ''}" data-act="clientTab" data-t="itr">Individual – ITR only <span class="cnt">${itr.length}</span></button>
    </div>
    <div class="consbar"><label class="small muted">Constitution
      <select data-change="consF"><option value="">All</option>${[...new Set(S.clients.map(c => c.constitution || 'Not set'))].sort().map(k => `<option ${k === cf ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></label>
      <label class="small muted">State<select data-change="stateF"><option value="">All</option>${statesAll.map(k => `<option ${k === stF ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></label>
      <label class="small muted">Show<select data-change="showF">${[['', 'Everyone'], ['gst', 'With GSTIN'], ['nogst', 'Without GSTIN'], ['nopan', 'PAN missing'], ['nocontact', 'No mobile or email'], ['nologin', 'No client login']].map(([v, l]) => `<option value="${v}" ${v === shF ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${stF || shF ? `<a href="#" data-act="cliFClear" class="small">Clear filters</a>` : ''}
      ${cf ? `<span class="fchip">${esc(cf)}: <b>${base.length}</b> client${base.length === 1 ? '' : 's'} (Business + ITR) <a href="#" data-act="consClear">✕ clear</a></span>` : ''}</div>
    ${tab === 'itr' && !cf ? `<p class="muted small">Clients here get only the yearly income tax return in their compliance calendar (plus advance tax if ticked). ITR ${fyL}: <b>${filedCount}</b> of ${itr.length} filed.</p>` : ''}
    <input id="search" class="search" placeholder="${tab === 'itr' ? 'Search name, PAN, mobile, email…' : 'Search name, PAN, any GSTIN, state, code, mobile…'}" value="${esc(S.search)}">
    ${isAdmin() && nSel ? `<div class="selbar"><b>${nSel} selected</b>
      ${cf ? `<button class="sm primary" data-act="moveSel" data-to="itr">Move to Individual – ITR only</button><button class="sm" data-act="moveSel" data-to="business">Move to Business clients</button>`
        : `<button class="sm primary" data-act="moveSel" data-to="${tab === 'itr' ? 'business' : 'itr'}">Move to ${tab === 'itr' ? 'Business clients' : 'Individual – ITR only'}</button>`}
      <button class="sm" data-act="selClear">Clear</button></div>` : ''}
    <table class="tbl"><thead>${head}</thead><tbody>
    ${list.map(row).join('') || `<tr><td colspan="7" class="muted empty">${q ? 'No match.' : tab === 'itr' ? 'No ITR-only clients. Move individuals here from Business clients.' : 'No clients yet.'}</td></tr>`}
    </tbody></table>
  </section>`;
}
async function moveClients(ids, to) {
  let b = writeBatch(db), n = 0;
  for (const id of ids) { b.update(doc(db, 'clients', id), { category: to, updatedAt: serverTimestamp() }); if (++n % 400 === 0) { await b.commit(); b = writeBatch(db); } }
  await b.commit();
  for (const c of S.clients) if (ids.includes(c.id)) c.category = to;
  if (S.client && ids.includes(S.client.id)) S.client.category = to;
}

/* ---------- single client ---------- */
function vClient() {
  const c = S.client || {};
  const tabs = [['master', 'Master data'], ['gst', `GST registrations${regsOf(c).length ? ` (${regsOf(c).length})` : ''}`], ['logins', 'Portal logins'], ['docs', 'Documents'], ['compliance', 'Compliance'], ['tasks', 'Tasks'], ...(isAdmin() ? [['access', 'Client access']] : [])];
  return `
  ${isAdmin() ? `<button class="link back" data-act="go" data-v="clients">← ${isItrOnly(S.client || {}) && S.cid ? 'ITR clients' : 'All clients'}</button>` : ''}
  <section class="card head">
    <div class="row-between wrap">
      <div><h1>${esc(c.name || 'New client')}</h1>
        <div class="chips">${S.cid ? (isItrOnly(c) ? '<span class="cat itr">Individual – ITR only</span>' : '<span class="cat biz">Business client</span>') : ''}${c.tradeName ? `<span>${esc(c.tradeName)}</span>` : ''}${c.constitution ? `<span>${esc(c.constitution)}</span>` : ''}
        ${c.pan ? `<span class="mono">PAN ${esc(c.pan)}</span>` : ''}${regsOf(c).length === 1 ? `<span class="mono">GSTIN ${esc(regsOf(c)[0].gstin)}</span>` : regsOf(c).length > 1 ? `<span>${regsOf(c).length} GSTINs · ${esc([...new Set(regsOf(c).map(r => r.state).filter(Boolean))].join(', '))}</span>` : ''}</div></div>
      <div class="btns">
        ${isAdmin() && S.cid ? `<button data-act="moveOne" data-to="${isItrOnly(c) ? 'business' : 'itr'}">Move to ${isItrOnly(c) ? 'Business clients' : 'ITR only'}</button>` : ''}
        ${isAdmin() && S.cid ? `<button class="primary wa" data-act="sendOpen">Send to client</button>` : ''}
        ${isAdmin() ? `<button class="primary" data-act="fromDoc" data-mode="update">Fill from document</button>` : ''}
        <button data-act="downloadClient">Download my data (Excel)</button>
      </div>
    </div>
    ${S.creds.length ? `<div class="quick"><span class="muted small">Quick login:</span>
      ${S.creds.map(cr => `<button class="sm pill" data-act="login" data-id="${cr.id}">${esc(portalByKey(cr.portal).short)}${cr.gstin && regsOf(c).length > 1 ? ' ' + esc(stateOf(cr.gstin) || cr.gstin.slice(0, 2)) : ''} ↗</button>`).join('')}</div>` : ''}
  </section>
  <div class="tabs">${tabs.map(([t, l]) => `<button class="${S.tab === t ? 'on' : ''}" data-act="tab" data-t="${t}">${l}</button>`).join('')}</div>
  <section class="card">${({ master: tMaster, logins: tLogins, docs: tDocs, compliance: tCompliance, access: tAccess, tasks: T.tClientTasks, gst: tGst })[S.tab]?.() || ''}</section>`;
}

function fieldInput([k, l, type, opts], v) {
  if (type === 'bool') return `<label class="chk"><input type="checkbox" name="${k}" ${v ? 'checked' : ''}> ${l}</label>`;
  let inp;
  if (type === 'select') inp = `<select name="${k}" ${k === 'constitution' ? 'data-change="consChange"' : ''}><option value=""></option>${opts.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
  else if (type === 'textarea') inp = `<textarea name="${k}" rows="3">${esc(v)}</textarea>`;
  else if (type === 'date') inp = `<input type="date" name="${k}" value="${esc(v)}">`;
  else inp = `<input name="${k}" value="${esc(v)}" ${UPPER.has(k) ? 'class="mono up"' : ''}>`;
  return `<label class="${type === 'textarea' ? 'span2' : ''}">${l}${inp}</label>`;
}
function tMaster() {
  const c = S.client || {};
  if (!isAdmin()) {
    return `<dl class="dl">${formFields(c.constitution).filter(f => c[f[0]] !== undefined && c[f[0]] !== '' && f[0] !== 'notes' && !GST_KEYS.has(f[0])).map(([k, l, t]) => `<dt>${l}</dt><dd>${
      t === 'bool' ? (c[k] ? 'Yes' : 'No') : t === 'date' ? isoToDisp(c[k]) : k === 'aadhaar' ? 'XXXX XXXX ' + esc(String(c[k]).slice(-4)) : esc(c[k]).replace(/\n/g, '<br>')}</dd>`).join('')}</dl>`;
  }
  return `<form data-form="master" class="grid">
    ${formFields(c.constitution).filter(f => f[2] !== 'bool' && !GST_KEYS.has(f[0])).map(f => fieldInput(f, c[f[0]])).join('')}
    ${FIELDS.filter(f => f[2] !== 'bool' && !GST_KEYS.has(f[0]) && !formFields(c.constitution).some(x => x[0] === f[0]) && c[f[0]]).map(f => `<input type="hidden" name="${f[0]}" value="${esc(c[f[0]])}">`).join('')}
    <p class="span2 muted small">GSTINs are managed in the <a href="#" data-act="tab" data-t="gst">GST registrations</a> tab — add one per state.</p>
    <div class="span2 bools">${FIELDS.filter(f => f[2] === 'bool').map(f => fieldInput(f, c[f[0]])).join('')}</div>
    <div class="span2 btns"><button class="primary">Save master data</button>
      ${S.client?.createdAt ? `<button type="button" class="danger" data-act="delClient">Delete client</button>` : ''}</div>
  </form>`;
}

function tGst() {
  const regs = regsOf(S.client), adm = isAdmin();
  const creds = g => S.creds.filter(cr => cr.gstin === g || (!cr.gstin && cr.portal === 'gst' && regs.length === 1 && !S.creds.some(x => x.gstin)));
  return `
  <div class="row-between wrap"><h2>GST registrations</h2>
    ${adm ? `<div class="btns"><button class="primary" data-act="editReg">+ Add GSTIN</button><button data-act="fromDoc" data-mode="update">Add from GST certificate</button></div>` : ''}</div>
  <p class="muted small">One entry per GSTIN (state / branch). Each gets its own GSTR-1, GSTR-3B and annual return in the compliance calendar, and its own portal login.</p>
  ${S.cid ? '' : '<p class="warn">Save the master data first, then add registrations.</p>'}
  <table class="tbl"><thead><tr><th>State</th><th>GSTIN</th><th>Trade name / address</th><th>Filing</th><th>Since</th><th>Status</th><th>Logins</th>${adm ? '<th></th>' : ''}</tr></thead><tbody>
  ${regs.map(r => `<tr><td><b>${esc(r.state || stateOf(r.gstin))}</b>${r.label ? `<div class="muted tiny">${esc(r.label)}</div>` : ''}</td>
    <td class="mono nowrap">${esc(r.gstin)}</td>
    <td>${esc(r.tradeName)}<div class="muted tiny">${esc(r.address)}</div></td>
    <td>${esc(r.gstFreq || 'Monthly')}</td><td class="nowrap">${isoToDisp(r.regDate)}</td>
    <td>${r.status === 'Cancelled' ? '<span class="tag red">Cancelled</span>' : '<span class="tag green">Active</span>'}</td>
    <td class="nowrap">${creds(r.gstin).map(cr => `<button class="sm pill" data-act="login" data-id="${cr.id}">${esc(portalByKey(cr.portal).short)} ↗</button>`).join(' ') || (adm ? `<button class="sm" data-act="editCred" data-gstin="${esc(r.gstin)}">+ Login</button>` : '—')}</td>
    ${adm ? `<td class="nowrap"><button class="sm" data-act="editReg" data-id="${r.id}">Edit</button> <button class="sm danger" data-act="delReg" data-id="${r.id}">Delete</button></td>` : ''}</tr>`).join('')
    || `<tr><td colspan="8" class="muted empty">No GST registration.${adm ? ' Add a GSTIN or upload a GST certificate.' : ''}</td></tr>`}
  </tbody></table>`;
}
// an older single-GSTIN client: link its existing GST / E-Way Bill / E-Invoice logins to that GSTIN
async function tagLegacyCreds(cid, base) {
  if (!base || Array.isArray(base.gstRegs) || !base.gstin) return;
  for (const d of (await getDocs(collection(db, 'clients', cid, 'credentials'))).docs) {
    const c = d.data();
    if (GST_PORTALS.has(c.portal) && !c.gstin) await updateDoc(d.ref, { gstin: base.gstin });
  }
}
async function saveRegs(regs) {
  await tagLegacyCreds(S.cid, S.client);
  await updateDoc(doc(db, 'clients', S.cid), { ...regMirror(regs), updatedAt: serverTimestamp() });
  await loadClients(); await openClient(S.cid, 'gst'); render();
}

function tLogins() {
  const rows = S.creds.map(cr => {
    const p = portalByKey(cr.portal), shown = S.reveal.has(cr.id);
    return `<div class="cred">
      <div class="cred-h"><div><b>${esc(cr.label || p.name)}</b>${cr.gstin ? `<div class="muted tiny mono">${esc(regLabel(regsOf(S.client).find(r => r.gstin === cr.gstin) || { gstin: cr.gstin, state: stateOf(cr.gstin) }))}</div>` : ''}</div>
        <button class="primary sm" data-act="login" data-id="${cr.id}">Login ↗</button></div>
      <div class="kv"><span>User ID</span><code>${esc(cr.username)}</code><button class="icon" title="Copy" data-act="copy" data-v="u" data-id="${cr.id}">⧉</button></div>
      <div class="kv"><span>Password</span><code>${shown ? esc(cr.password) : '••••••••'}</code>
        <button class="icon" title="Show" data-act="reveal" data-id="${cr.id}">${shown ? '🙈' : '👁'}</button>
        <button class="icon" title="Copy" data-act="copy" data-v="p" data-id="${cr.id}">⧉</button></div>
      ${cr.notes ? `<div class="muted small">${esc(cr.notes)}</div>` : ''}
      ${cr.updatedAt ? `<div class="muted tiny">Updated ${fmtDate(cr.updatedAt.toDate?.())}</div>` : ''}
      ${isAdmin() ? `<div class="btns"><button class="sm" data-act="editCred" data-id="${cr.id}">Edit</button>
        <button class="sm danger" data-act="delCred" data-id="${cr.id}">Delete</button></div>` : ''}
    </div>`;
  }).join('');
  return `
  <div class="row-between wrap"><h2>Portal logins</h2>${isAdmin() ? `<button class="primary" data-act="editCred">+ Add login</button>` : ''}</div>
  ${extOn() ? '<p class="ok small">Autofill extension active — Login fills the user ID and password; you enter CAPTCHA/OTP.</p>'
    : '<p class="muted small">Login opens the portal and copies the password. Install the CA Desk Autofill extension to fill both fields automatically.</p>'}
  <div class="creds">${rows || '<p class="muted empty">No logins saved.</p>'}</div>`;
}

function tDocs() {
  return `
  <div class="row-between wrap"><h2>Documents</h2>${isAdmin() && S.docs.length ? '<button class="wa primary" data-act="sendSelected">Send selected on WhatsApp / Email</button>' : ''}</div>
  ${isAdmin() ? `<div class="upload">
    <select id="docCat">${DOC_CATS.map(c => `<option>${c}</option>`).join('')}</select>
    <label class="filebtn">Upload files<input type="file" multiple data-change="uploadDocs" accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.doc,.docx,.zip,.json"></label>
    <span class="muted small">Max 10 MB per file.</span></div>` : ''}
  <table class="tbl"><thead><tr>${isAdmin() ? '<th><input type="checkbox" data-change="docpickAll" title="Select all"></th>' : ''}<th>Document</th><th>Category</th><th>Size</th><th>Uploaded</th><th></th></tr></thead><tbody>
  ${S.docs.map(d => `<tr>${isAdmin() ? `<td><input type="checkbox" class="docpick" value="${d.id}"></td>` : ''}<td>${esc(d.name)}</td><td>${esc(d.category)}</td><td class="nowrap">${(d.size / 1024).toFixed(0)} KB</td>
    <td class="nowrap">${d.uploadedAt ? fmtDate(d.uploadedAt.toDate()) : ''}</td>
    <td class="nowrap"><button class="sm" data-act="dlDoc" data-id="${d.id}">Download</button>
    ${isAdmin() ? `<button class="sm danger" data-act="delDoc" data-id="${d.id}">Delete</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="5" class="muted empty">No documents yet.</td></tr>'}
  </tbody></table>`;
}

function complianceRows() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const from = new Date(today.getFullYear(), today.getMonth() - 6, 1);
  const to = new Date(today.getFullYear(), today.getMonth() + 4, 0);
  return dueItems(S.client || {}, from, to).map(it => ({ ...it, f: filingFor(S.filings, it), overdue: it.due < today }));
}
function tCompliance() {
  const rows = complianceRows();
  return `
  <div class="row-between wrap"><h2>Compliance calendar</h2><span class="muted small">Last 6 months and next 3 months, based on master data</span></div>
  <table class="tbl"><thead><tr><th>Due</th><th>Return / form</th><th>Period</th><th>Status</th><th></th></tr></thead><tbody>
  ${rows.map(r => {
    const filed = r.f?.status === 'filed';
    const st = filed ? `<span class="tag green">Filed ${r.f.filedOn ? isoToDisp(r.f.filedOn) : ''}</span>${r.f.ack ? `<div class="muted tiny mono">${esc(r.f.ack)}</div>` : ''}`
      : r.overdue ? (r.note === 'Optional' ? '<span class="tag">Not filed</span>' : '<span class="tag red">Overdue</span>') : '<span class="tag amber">Pending</span>';
    return `<tr><td class="nowrap">${fmtDate(r.due)}</td><td>${esc(r.form)}${r.note ? ` <span class="tag">${esc(r.note)}</span>` : ''}</td>
      <td>${esc(r.period)}</td><td>${st}</td>
      <td>${isAdmin() ? (filed ? `<button class="sm" data-act="unfile" data-key="${r.key}" data-alt="${r.altKey || ''}">Undo</button>`
        : `<button class="sm" data-act="markFiled" data-cid="${S.cid}" data-key="${r.key}">Mark filed</button>`) : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="5" class="muted empty">Add GST registrations, constitution and the applicability ticks in master data to see due dates.</td></tr>'}
  </tbody></table>
  <p class="muted small">Statutory due dates; government extensions are not applied automatically.</p>`;
}

function tAccess() {
  if (LOCAL) return `<h2>Client access</h2><p class="muted">Client logins switch on once the app is connected to Firebase. Until then, use “Download my data (Excel)” to send a client their master data, portal logins and compliance status.</p>`;
  const users = S.client?.portalUsers || [];
  return `
  <h2>Client access</h2>
  <p class="muted small">Give the client a login to this portal. They will see only their own master data, portal logins, documents and compliance status (read-only) and can download them.</p>
  <table class="tbl"><thead><tr><th>Login email</th><th>Status</th><th></th></tr></thead><tbody>
  ${users.map(u => `<tr><td>${esc(u.email)}</td><td>${u.revoked ? '<span class="tag red">Revoked</span>' : '<span class="tag green">Active</span>'}</td>
    <td class="nowrap">${u.revoked ? `<button class="sm" data-act="restoreAccess" data-uid="${u.uid}">Restore</button>`
      : `<button class="sm" data-act="resetPw" data-email="${esc(u.email)}">Send password reset</button>
         <button class="sm danger" data-act="revoke" data-uid="${u.uid}">Revoke</button>`}</td></tr>`).join('')
    || '<tr><td colspan="3" class="muted empty">No client login yet.</td></tr>'}
  </tbody></table>
  <form data-form="newClientLogin" class="grid narrow">
    <label>Client email<input name="email" type="email" required value="${esc(S.client?.email || '')}"></label>
    <label>Temporary password<input name="pw" required minlength="8" value="${genPw()}"></label>
    <div class="span2"><button class="primary">Create client login</button>
    <span class="muted small">Share the email and temporary password with the client; they can change it with “Forgot password”.</span></div>
  </form>`;
}
function genPw() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#';
  return Array.from(crypto.getRandomValues(new Uint32Array(10)), x => a[x % a.length]).join('');
}

/* ---------- excel import ---------- */
const XL_FIELDS = [
  ['Client Code', 'code'], ['Legal Name', 'name'], ['Trade Name', 'tradeName'], ['Constitution', 'constitution'],
  ['PAN', 'pan'], ['GSTIN', 'gstin'], ['TAN', 'tan'], ['CIN/LLPIN', 'cin'], ['DOB/DOI (DD-MM-YYYY)', 'doi'],
  ['GST Reg Date (DD-MM-YYYY)', 'gstRegDate'], ['Aadhaar', 'aadhaar'], ['Email', 'email'], ['Mobile', 'mobile'],
  ['Address', 'address'], ['State', 'state'], ['PIN', 'pincode'],
  ['GST Filing (Monthly/QRMP/Composition/Not registered)', 'gstFreq'],
  ['TDS (Y/N)', 'tds'], ['PF/ESIC (Y/N)', 'pfesic'], ['Tax Audit (Y/N)', 'audit'], ['Advance Tax (Y/N)', 'advTax'],
  ['Partners/Directors', 'people'], ['Notes', 'notes'],
];
const XL_PORTALS = PORTALS.filter(p => p.key !== 'other');
const xlHeaders = () => [...XL_FIELDS.map(x => x[0]), ...XL_PORTALS.flatMap(p => [`${p.short} User`, `${p.short} Password`])];
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const BOOLS = new Set(['tds', 'pfesic', 'audit', 'advTax']);

function vImport() {
  const r = S.importRows;
  return `
  <section class="card">
    <h2>Import clients from Excel</h2>
    <ol class="steps">
      <li><button data-act="xlTemplate">Download the template</button> — one row per GSTIN. For a client with several states, add one row per GSTIN with the same PAN; they are combined into one client.</li>
      <li>Fill master data and the user ID / password columns for each portal. Leave blanks where not applicable.</li>
      <li>Upload it below. Existing clients are matched by PAN, then GSTIN, then client code, and updated (new GSTINs are added); others are created.</li>
    </ol>
    <label class="filebtn">Choose Excel file<input type="file" accept=".xlsx,.xls,.csv" data-change="xlFile"></label>
    <p class="muted small">Tip: “Export all” on the Clients page produces the same format — use it as a backup or to bulk-edit and re-import.</p>
    ${r ? `<hr><p><b>${r.length}</b> client(s) found: <b>${r.filter(x => x._match).length}</b> will update existing clients, <b>${r.filter(x => !x._match).length}</b> will be new. Rows with the same PAN are combined into one client with several GSTINs.</p>
      <table class="tbl"><thead><tr><th>Name</th><th>PAN</th><th>GSTINs</th><th>Logins</th><th>Action</th></tr></thead><tbody>
      ${r.slice(0, 300).map(x => `<tr><td>${esc(x.f.name)}</td><td class="mono">${esc(x.f.pan)}</td>
        <td>${x.regs.map(g => `<div class="mono small">${esc(g.gstin)} <span class="muted">${esc(g.state)}</span></div>`).join('') || '—'}</td>
        <td>${x.creds.map(c => portalByKey(c.portal).short + (c.gstin && x.regs.length > 1 ? ' ' + esc(stateOf(c.gstin) || '') : '')).join(', ')}</td><td>${x._match ? 'Update' : 'New'}</td></tr>`).join('')}
      </tbody></table>
      <button class="primary" data-act="xlImport">Import ${r.length} client(s)</button>` : ''}
  </section>`;
}

// create tasks for due returns that don't have one yet (runs in the background, then refreshes the screen)
function autoTasks() {
  setTimeout(() => T.autoSync().then(n => { if (n) { render(); toast(`${n} new task(s) created for returns falling due`); } }).catch(e => console.warn('autoTasks', e)), 300);
}
/* ---------- reminders to clients on WhatsApp / email ---------- */
const WA_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.2A9.7 9.7 0 0 0 3.6 16.8L2.3 21.7l5-1.3A9.7 9.7 0 1 0 12 2.2Zm0 17.7a8 8 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 19.9Zm4.4-6c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1l-.8 1c-.1.2-.3.2-.5.1a6.6 6.6 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.5-.4h-.5a.9.9 0 0 0-.7.3 2.8 2.8 0 0 0-.9 2.1 4.9 4.9 0 0 0 1 2.6 11.2 11.2 0 0 0 4.3 3.8c1.6.7 2.2.7 3 .6a2.5 2.5 0 0 0 1.7-1.2 2 2 0 0 0 .1-1.2c0-.1-.2-.2-.4-.3Z"/></svg>';
const MAIL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/></svg>';
const waNum = s => { const d = String(s || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d.replace(/^0+/, ''); };
function remindBtns(cid, key) {
  const c = S.clients.find(x => x.id === cid) || {};
  const last = (c.reminders || []).filter(r => (r.keys || []).includes(key)).pop();
  return `<span class="rbtns"><button class="rb wa ${c.mobile ? '' : 'off'}" data-act="remind" data-cid="${cid}" data-keys="${esc(key)}" data-via="wa" title="${c.mobile ? 'WhatsApp ' + esc(c.mobile) : 'No mobile saved — add one when sending'}">${WA_ICON}</button><button class="rb em ${c.email ? '' : 'off'}" data-act="remind" data-cid="${cid}" data-keys="${esc(key)}" data-via="mail" title="${c.email ? 'Email ' + esc(c.email) : 'No email saved — add one when sending'}">${MAIL_ICON}</button></span>${last ? `<span class="rlast" title="Last reminder">${isoToDisp(isoLocalD(new Date(last.at)))} · ${last.via === 'wa' ? 'WhatsApp' : 'Email'}</span>` : ''}`;
}
// pending returns for a client, by key (works for GST "@GSTIN" keys too)
function pendingFor(cid, keys) {
  const c = S.clients.find(x => x.id === cid); const y = new Date().getFullYear();
  return dueItems(c, new Date(y - 2, 0, 1), new Date(y + 1, 11, 31)).filter(it => keys.includes(it.key) || (it.altKey && keys.includes(it.altKey)));
}
function reminderText(c, items) {
  const L = [`Dear ${c.name || 'Sir/Madam'},`, '', items.length > 1 ? 'Gentle reminder — the following are due:' : 'Gentle reminder — the following is due:', ''];
  const docs = new Set();
  for (const it of items) {
    const late = it.due < dayStart(new Date());
    L.push(`• ${it.form}${it.gstin ? ` (GSTIN ${it.gstin})` : ''} for ${it.period} — due ${fmtDate(it.due)}${late ? ' (overdue)' : ''}`);
    for (const d of T.docsFor(c.id, it.key)) docs.add(d);
  }
  if (docs.size) { L.push('', 'Please share the following at the earliest:'); for (const d of docs) L.push(`  – ${d}`); }
  L.push('', 'If already shared, kindly ignore this message.', '', 'Regards,', S.firm || '', S.profile?.name && S.profile.name !== S.firm ? S.profile.name : '');
  return L.filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n').trim();
}
function openReminder(cid, keys, via) {
  const c = S.clients.find(x => x.id === cid); const items = pendingFor(cid, keys);
  S.remind = { cid, keys };
  modal(`<h2>Send reminder — ${esc(c.name)}</h2>
    <div class="grid">
      <label>WhatsApp number<input id="rPhone" value="${esc(c.mobile || '')}" placeholder="10-digit mobile"></label>
      <label>Email<input id="rEmail" type="email" value="${esc(c.email || '')}" placeholder="client@example.com"></label>
      ${!c.mobile || !c.email ? '<label class="chk span2"><input type="checkbox" id="rSave" checked> Save the number / email to this client</label>' : ''}
      <label class="span2">Message<textarea id="rMsg" rows="12">${esc(reminderText(c, items))}</textarea></label>
    </div>
    <div class="btns mt"><button class="primary wa" data-act="remindSend" data-via="wa">${WA_ICON} Send on WhatsApp</button>
      <button data-act="remindSend" data-via="gmail">${MAIL_ICON} Send with Gmail</button><button data-act="remindSend" data-via="mail">Email app</button>
      <button data-act="remindCopy">Copy message</button><button data-act="closeModal">Cancel</button></div>`);
  setTimeout(() => document.querySelector(via === 'mail' ? '#rEmail' : '#rPhone')?.focus(), 50);
}
async function remindSend(via) {
  const { cid, keys } = S.remind, c = S.clients.find(x => x.id === cid);
  const phone = $('#rPhone').value.trim(), email = $('#rEmail').value.trim(), text = $('#rMsg').value;
  const subject = `Reminder: ${[...new Set(pendingFor(cid, keys).map(i => `${baseForm(i.form)} ${i.period}`))].join(', ')} — ${S.firm || ''}`;
  if (via === 'wa') { if (waNum(phone).length < 11) throw new Error('Enter the client\'s WhatsApp number.'); window.open(`https://wa.me/${waNum(phone)}?text=${encodeURIComponent(text)}`, '_blank', 'noopener'); }
  else { if (!email) throw new Error('Enter the client\'s email.');
    if (via === 'gmail') window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`, '_blank', 'noopener');
    else location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`; }
  const rec = { at: new Date().toISOString(), by: S.profile?.email || '', via: via === 'wa' ? 'wa' : 'mail', to: via === 'wa' ? phone : email, keys };
  const upd = { reminders: arrayUnion(rec) };
  if ($('#rSave')?.checked) { if (phone && !c.mobile) upd.mobile = phone; if (email && !c.email) upd.email = email; }
  await updateDoc(doc(db, 'clients', cid), upd);
  c.reminders = [...(c.reminders || []), rec]; if (upd.mobile) c.mobile = upd.mobile; if (upd.email) c.email = upd.email;
  for (const k of keys) await T.logReminder(cid, k, `Reminder sent on ${via === 'wa' ? 'WhatsApp' : 'email'} to ${rec.to}`);
  closeModal(); render();
}
// a whole compliance group: one row per client, each with its own WhatsApp / email button
function openBulkRemind(name) {
  const rows = dueRows({ back: 365, ahead: 62, history: S.dueF?.history }).filter(r => baseForm(r.form) === name);
  const by = new Map(); for (const r of rows) (by.get(r.c.id) || by.set(r.c.id, []).get(r.c.id)).push(r.key);
  S.bulkRem = [...by.entries()];
  modal(`<h2>Remind everyone pending — ${esc(name)}</h2>
    <p class="muted small">WhatsApp can't send in bulk from a website, so each button opens WhatsApp (or email) with that client's message ready. Rows turn green once sent.</p>
    <div class="bulkrem">${S.bulkRem.map(([cid, keys]) => { const c = S.clients.find(x => x.id === cid); return `<div class="br-row" id="br_${cid}"><span><b>${esc(c.name)}</b><small>${esc(c.mobile || 'no mobile')} · ${esc(c.email || 'no email')}</small></span>
      <span class="rbtns"><button class="rb wa ${c.mobile ? '' : 'off'}" data-act="remindQuick" data-cid="${cid}" data-via="wa" title="WhatsApp">${WA_ICON}</button><button class="rb em ${c.email ? '' : 'off'}" data-act="remindQuick" data-cid="${cid}" data-via="gmail" title="Gmail">${MAIL_ICON}</button><button class="sm" data-act="remind" data-cid="${cid}" data-keys="${esc(keys.join(','))}" data-via="wa">Edit…</button></span></div>`; }).join('')}</div>
    <div class="btns mt"><button data-act="closeModal">Done</button></div>`);
}

/* ---------- compliances: pick a compliance / task, tick the clients it applies to ---------- */
// type 'flag' = client opt-in flag (drives the calendar); 'auto' = applies by law (GSTIN / constitution), can be switched off per client;
// 'service' = work you do that has no statutory due date (stored in client.services)
const COMPS = [
  { id: 'GSTR1', name: 'GSTR-1 / IFF', type: 'auto', codes: ['GSTR1', 'IFF'], grp: 'GST' },
  { id: 'GSTR3B', name: 'GSTR-3B / PMT-06', type: 'auto', codes: ['GSTR3B', 'PMT06'], grp: 'GST' },
  { id: 'CMP08', name: 'CMP-08 (composition)', type: 'auto', codes: ['CMP08'], grp: 'GST' },
  { id: 'GSTR9', name: 'GSTR-9 annual return', type: 'auto', codes: ['GSTR9'], grp: 'GST' },
  { id: 'GSTR4', name: 'GSTR-4 annual return', type: 'auto', codes: ['GSTR4'], grp: 'GST' },
  { id: 'ITR', name: 'Income tax return', type: 'auto', codes: ['ITR'], grp: 'Income tax' },
  { id: 'audit', name: 'Tax audit (3CD)', type: 'flag', flag: 'audit', grp: 'Income tax' },
  { id: 'advTax', name: 'Advance tax', type: 'flag', flag: 'advTax', grp: 'Income tax' },
  { id: 'tds', name: 'TDS / TCS (payment & returns)', type: 'flag', flag: 'tds', grp: 'TDS & payroll' },
  { id: 'pfesic', name: 'PF / ESIC', type: 'flag', flag: 'pfesic', grp: 'TDS & payroll' },
  { id: 'AOC4', name: 'AOC-4 (financials)', type: 'auto', codes: ['AOC4'], grp: 'ROC' },
  { id: 'MGT7', name: 'MGT-7 / 7A', type: 'auto', codes: ['MGT7'], grp: 'ROC' },
  { id: 'DPT3', name: 'DPT-3', type: 'auto', codes: ['DPT3'], grp: 'ROC' },
  { id: 'DIR3', name: 'DIR-3 KYC', type: 'auto', codes: ['DIR3'], grp: 'ROC' },
  { id: 'MSME1', name: 'MSME-1', type: 'auto', codes: ['MSME1'], grp: 'ROC' },
  { id: 'LLP11', name: 'LLP Form 11', type: 'auto', codes: ['LLP11'], grp: 'ROC' },
  { id: 'LLP8', name: 'LLP Form 8', type: 'auto', codes: ['LLP8'], grp: 'ROC' },
  { id: 'BOOKS', name: 'Monthly bookkeeping', type: 'service', grp: 'Other work' },
  { id: 'FS', name: 'Finalisation of accounts', type: 'service', grp: 'Other work' },
  { id: 'GEN', name: 'General work', type: 'service', grp: 'Other work' },
];
const compById = id => COMPS.find(x => x.id === id) || (id.startsWith('svc:') ? { id, name: id.slice(4), type: 'service', grp: 'Other work' } : null);
// clients the law makes it possible for (ignoring this client's own switch-offs)
const compEligible = (cp, c) => {
  if (cp.type !== 'auto') return true;
  const y = new Date().getFullYear(), its = dueItems({ ...c, off: [] }, new Date(y - 1, 0, 1), new Date(y + 1, 11, 31));
  return its.some(i => cp.codes.includes(codeOf(i.key)));
};
const compOn = (cp, c) => cp.type === 'flag' ? !!c[cp.flag] && !isItrOnly(c)
  : cp.type === 'service' ? (c.services || []).includes(cp.id)
  : compEligible(cp, c) && !cp.codes.some(k => (c.off || []).includes(k));
function vComps() {
  const svcExtra = [...new Set(S.clients.flatMap(c => c.services || []).filter(x => x.startsWith('svc:')))].map(compById);
  const all = [...COMPS, ...svcExtra];
  const cnt = cp => S.clients.filter(c => compOn(cp, c)).length;
  const groups = [...new Set(all.map(x => x.grp))];
  const sel = S.compSel && compById(S.compSel);
  return `
  <section class="card">
    <div class="row-between wrap"><h2>Compliances &amp; work</h2><button class="sm" data-act="compNew">+ Add other work</button></div>
    <p class="muted small">Click a compliance or task to see and tick the clients it applies to. The due-dates calendar and task generation follow these ticks.</p>
    ${groups.map(g => `<h3 class="cgrp">${esc(g)}</h3><div class="cbtns">${all.filter(x => x.grp === g).map(cp => `
      <button class="compbtn ${S.compSel === cp.id ? 'on' : ''}" data-act="compOpen" data-id="${esc(cp.id)}"><span>${esc(cp.name)}</span><b>${cnt(cp)}</b></button>`).join('')}</div>`).join('')}
  </section>
  ${sel ? compPanel(sel) : ''}`;
}
function compPanel(cp) {
  const q = (S.compQ || '').toLowerCase(), cf = S.compCons || '';
  const elig = S.clients.filter(c => compEligible(cp, c) && !(cp.type === 'flag' && isItrOnly(c)));
  const pick = S.compPick ||= new Set(elig.filter(c => compOn(cp, c)).map(c => c.id));
  const shown = elig.filter(c => (!cf || (c.constitution || 'Not set') === cf) && (!q || [c.name, c.tradeName, c.pan, c.gstin].some(v => (v || '').toLowerCase().includes(q))))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const notElig = S.clients.length - elig.length;
  const why = cp.type === 'auto' ? `Only clients for whom ${esc(cp.name)} can arise are listed (GSTIN / filing type / constitution)${notElig ? ` — ${notElig} others don't qualify` : ''}.`
    : cp.type === 'flag' ? `Ticking switches on ${esc(cp.name)} in the client's compliance calendar.${notElig ? ` ITR-only clients (${notElig}) are excluded.` : ''}`
    : 'Work without a statutory due date. Use "Create tasks" to raise a task for every ticked client.';
  return `<section class="card" id="compPanel">
    <div class="row-between wrap"><h2>${esc(cp.name)} <span class="muted">(${pick.size} of ${elig.length} ticked)</span></h2>
      <div class="btns"><button class="primary" data-act="compSave">Save</button>
        <button data-act="compTasks">Create tasks for ticked clients…</button><button data-act="compClose">Close</button></div></div>
    <p class="muted small">${why}</p>
    <div class="filters">
      <input id="compQ" placeholder="Search client, PAN, GSTIN…" value="${esc(S.compQ || '')}">
      <select data-change="compCons"><option value="">All constitutions</option>${[...new Set(elig.map(c => c.constitution || 'Not set'))].sort().map(k => `<option ${k === cf ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select>
      <button class="sm" data-act="compAll" data-v="1">Tick all shown</button><button class="sm" data-act="compAll" data-v="">Untick all shown</button>
    </div>
    <div class="cgrid">${shown.map(c => `<label class="cpick ${pick.has(c.id) ? 'on' : ''}"><input type="checkbox" data-change="compPick" value="${c.id}" ${pick.has(c.id) ? 'checked' : ''}>
      <span><b>${esc(c.name)}</b><span class="muted tiny">${esc(c.constitution || '')}${c.pan ? ' · ' + esc(c.pan) : ''}${regsOf(c).length ? ' · ' + regsOf(c).length + ' GSTIN' : ''}</span></span></label>`).join('') || '<p class="muted">No clients match.</p>'}</div>
  </section>`;
}
async function compSave(cp) {
  const pick = S.compPick; let b = writeBatch(db), n = 0, changed = 0;
  for (const c of S.clients) {
    if (!compEligible(cp, c) || (cp.type === 'flag' && isItrOnly(c))) continue;
    const want = pick.has(c.id); if (want === compOn(cp, c)) continue;
    let upd;
    if (cp.type === 'flag') upd = { [cp.flag]: want };
    else if (cp.type === 'service') { const sv = new Set(c.services || []); want ? sv.add(cp.id) : sv.delete(cp.id); upd = { services: [...sv] }; }
    else { const off = new Set(c.off || []); for (const k of cp.codes) want ? off.delete(k) : off.add(k); upd = { off: [...off] }; }
    b.update(doc(db, 'clients', c.id), { ...upd, updatedAt: serverTimestamp() }); Object.assign(c, upd); changed++;
    if (S.client?.id === c.id) Object.assign(S.client, upd);
    if (++n % 400 === 0) { await b.commit(); b = writeBatch(db); }
  }
  await b.commit(); return changed;
}

/* ---------- settings ---------- */
function vSettings() {
  return `
  <section class="card">
    <h2>Firm</h2>
    <form data-form="firm" class="grid narrow"><label>Firm name<input name="firm" value="${esc(S.firm)}" required></label>
      <div class="span2"><button class="primary">Save</button></div></form>
  </section>
  <section class="card">
    <h2>Attach documents from your computer</h2>
    <p class="muted small">Choose your <b>DATA MANAGEMENT</b> folder. PAN, Aadhaar, incorporation certificates, MOA/AOA, GST registration certificates, TAN, Udyam and other certificates are attached to the right client's Documents tab. Files already attached are skipped, so it is safe to run again.</p>
    <label class="filebtn primarybtn">Choose DATA MANAGEMENT folder<input type="file" webkitdirectory multiple data-change="folderAttach"></label>
    ${S.attachReport || ''}
  </section>
  <section class="card">
    <h2>Google Drive</h2>
    <p class="muted small">Fill master data from a Drive folder that has one sub-folder per client (GST certificate, PAN, TAN, incorporation, deed). Read-only access; re-running only fills blanks and adds new documents.</p>
    <button class="primary" data-act="driveOpen">Import from Google Drive</button>
  </section>
  <section class="card">
    <h2>Backup &amp; restore</h2>
    ${LOCAL ? '<p class="muted small">In local mode everything lives in this browser. Download a backup regularly and keep it safe — clearing browser data deletes it. The backup also moves your data to another computer or into Firebase later.</p>'
      : '<p class="muted small">Your data is stored in Firebase. A backup file is still useful as an offline copy.</p>'}
    <div class="btns"><button class="primary" data-act="backup">Download full backup</button>
    ${LOCAL ? '<label class="filebtn ghostbtn">Restore from backup<input type="file" accept=".json" data-change="restore"></label>'
      : `<label class="filebtn ghostbtn">Import backup file into cloud<input type="file" accept=".json" data-change="cloudImport"></label>
         <button data-act="importLocal">Move this browser's local data to cloud</button>`}</div>
    ${LOCAL ? '' : '<p class="muted small">Import adds or overwrites clients, logins, documents, tasks and workflow from the backup. Logins and firm settings are not changed.</p>'}
  </section>
  ${LOCAL ? '' : `<section class="card">
    <h2>Staff logins</h2>
    <p class="muted small">Staff get full access to all clients (same as you).</p>
    <div id="staffList" class="muted small">Loading…</div>
    <form data-form="newStaff" class="grid narrow">
      <label>Staff name<input name="name" required></label>
      <label>Email<input name="email" type="email" required></label>
      <label>Temporary password<input name="pw" required minlength="8" value="${genPw()}"></label>
      <div class="span2"><button class="primary">Create staff login</button></div>
    </form>
  </section>`}
  <section class="card">
    <h2>Autofill extension</h2>
    <p>${extOn() ? '<span class="tag green">Installed and active</span>' : '<span class="tag">Not detected</span>'}</p>
    <p class="muted small">Load the <code>extension</code> folder in Chrome (chrome://extensions → Developer mode → Load unpacked). Clients can install it too.</p>
  </section>`;
}
async function loadStaff() {
  const el = $('#staffList'); if (!el || LOCAL) return;
  const snap = await getDocs(query(collection(db, 'users'), where('role', '==', 'admin')));
  el.innerHTML = snap.docs.map(d => `<div>${esc(d.data().name || '')} — ${esc(d.data().email)}${d.id === S.profile.uid ? ' (you)' : ''}</div>`).join('');
}

/* ================= actions ================= */
const A = {
  logout: () => signOut(auth),
  googleLogin: () => {
    const p = new M.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
    M.signInWithPopup(auth, p).catch(e => { if (!/popup-closed|cancelled-popup/.test(e.code || '')) toast(niceErr(e), 6000); });
  },
  importLocal: () => guard(async () => {
    const docs = await readLocalIDB();
    const keys = Object.keys(docs).filter(k => k.startsWith('clients/') || k.startsWith('tasks/') || k === 'meta/workflow' || k === 'meta/counters');
    if (!keys.length) throw new Error('No local data found in this browser.');
    if (!confirm(`Move ${Object.keys(docs).filter(k => /^clients\/[^/]+$/.test(k)).length} client(s) and ${keys.filter(k => /^tasks\//.test(k)).length} task(s) from this browser into the cloud?`)) return;
    await afterImport(await importDocs(docs));
  }),
  backup: () => guard(async () => {
    let json;
    if (LOCAL) json = M.exportAll();
    else {
      const docs = {};
      const add = snap => snap.forEach(d => docs[d.ref.path] = d.data());
      add(await getDocs(collection(db, 'clients')));
      add(await getDocs(collection(db, 'tasks')));
      for (const m of ['workflow', 'counters']) { const d = await getDoc(doc(db, 'meta', m)); if (d.exists()) docs['meta/' + m] = d.data(); }
      for (const c of S.clients) for (const sub of ['credentials', 'filings', 'docs']) {
        const sn = await getDocs(collection(db, 'clients', c.id, sub)); add(sn);
        if (sub === 'docs') for (const d of sn.docs) add(await getDocs(collection(db, 'clients', c.id, 'docs', d.id, 'chunks')));
      }
      json = JSON.stringify({ app: 'ca-desk', version: 1, exportedAt: new Date().toISOString(), docs });
    }
    saveBlob(new Blob([json], { type: 'application/json' }), `CA-Desk-backup-${todayISO()}.json`);
  }, 'Backup downloaded'),
  forgot: async () => {
    const email = prompt('Enter your login email. A password reset link will be sent.');
    if (email) guard(() => sendPasswordResetEmail(auth, email.trim()), 'Reset link sent — check your inbox.');
  },
  go: ({ v }) => { if (v === 'due') { S.dueDay = ''; if (S.dueOpen?.has('*')) S.dueOpen = new Set(); } S.view = v; window.scrollTo(0, 0); S.importRows = v === 'import' ? S.importRows : null; render(); if (v === 'settings') loadStaff(); },
  open: ({ id, tab }) => guard(async () => { await openClient(id, tab || 'master'); render(); }),
  tab: ({ t }) => { S.tab = t; render(); },
  dueToggle: ({ k }) => { const o = S.dueOpen ||= new Set(); if (o.has('*')) { o.delete('*'); for (const b of document.querySelectorAll('[data-act=dueToggle]')) o.add(b.dataset.k); } o.has(k) ? o.delete(k) : o.add(k); render(); },
  dueAll: ({ v }) => { S.dueOpen = new Set(); if (v) for (const b of document.querySelectorAll('[data-act=dueToggle]')) S.dueOpen.add(b.dataset.k); render(); },
  mixOpen: ({ k }) => { S.consF = k; S.search = ''; S.sel = new Set(); S.view = 'clients'; render(); },
  cliShow: ({ v }) => { S.showF = v; S.stateF = ''; S.consF = ''; S.view = 'clients'; render(); },
  cliFClear: () => { S.stateF = ''; S.showF = ''; render(); },
  consClear: () => { S.consF = ''; render(); },
  compOpen: ({ id }) => { S.compSel = S.compSel === id ? null : id; S.compPick = null; S.compQ = ''; S.compCons = ''; render(); if (S.compSel) setTimeout(() => document.getElementById('compPanel')?.scrollIntoView({ behavior: 'smooth' }), 50); },
  compClose: () => { S.compSel = null; S.compPick = null; render(); },
  compAll: ({ v }) => { for (const i of document.querySelectorAll('[data-change=compPick]')) v ? S.compPick.add(i.value) : S.compPick.delete(i.value); render(); },
  compSave: () => guard(async () => { const n = await compSave(compById(S.compSel)); S.compPick = null; render(); toast(n ? `Saved — ${n} client(s) updated` : 'No changes'); if (n) autoTasks(); }),
  compNew: () => { const n = prompt('Name of the work (e.g. Monthly MIS, Trademark renewal)'); if (n?.trim()) { S.compSel = 'svc:' + n.trim(); S.compPick = new Set(); render(); } },
  compTasks: () => {
    const cp = compById(S.compSel), ids = [...S.compPick];
    if (!ids.length) return toast('Tick at least one client first');
    guard(() => compSave(cp)); // keep the ticks as the clients this work applies to
    const catId = cp.type === 'flag' ? ({ tds: 'TDSRET', pfesic: 'EPF', audit: '3CD', advTax: 'ADV' })[cp.id] : cp.type === 'service' ? (cp.id.startsWith('svc:') ? 'GEN' : cp.id) : cp.id;
    A.newTask({ multi: ids, cat: catId, title: cp.id.startsWith('svc:') ? cp.name : '' });
  },
  dueOpenForm: ({ k }) => { S.dueF ||= { range: '30', form: '', q: '', history: false }; S.dueF.form = k; S.dueF.q = ''; S.view = 'due'; render(); },
  gqOpen: ({ id }) => { S.gq = ''; guard(async () => { await openClient(id, 'master'); render(); }); },
  dueDay: ({ d }) => { S.dueDay = d; S.dueF ||= { range: '30', form: '', q: '', history: false }; if (new Date(d) < dayStart(new Date())) S.dueF.history = false; S.dueOpen = new Set(['*']); S.view = 'due'; render(); },
  dueDayClear: () => { S.dueDay = ''; S.dueOpen = new Set(); render(); },
  dueOverdue: () => { S.dueF ||= { range: '30', form: '', q: '', history: false }; S.dueF.range = 'overdue'; S.dueDay = ''; S.dueOpen = new Set(['*']); S.view = 'due'; render(); },
  remind: ({ cid, keys, via }) => openReminder(cid, keys.split(','), via),
  remindSend: ({ via }) => guard(() => remindSend(via), 'Reminder logged'),
  remindCopy: () => { navigator.clipboard?.writeText($('#rMsg').value); toast('Message copied'); },
  remindAll: ({ k }) => openBulkRemind(k),
  remindQuick: ({ cid, via }) => guard(async () => {
    const keys = S.bulkRem.find(x => x[0] === cid)[1], c = S.clients.find(x => x.id === cid), text = reminderText(c, pendingFor(cid, keys));
    if (via === 'wa') { if (!c.mobile) throw new Error('No mobile saved for this client — use Edit… to add one.'); window.open(`https://wa.me/${waNum(c.mobile)}?text=${encodeURIComponent(text)}`, '_blank', 'noopener'); }
    else { if (!c.email) throw new Error('No email saved for this client — use Edit… to add one.'); window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(c.email)}&su=${encodeURIComponent('Reminder — ' + (S.firm || ''))}&body=${encodeURIComponent(text)}`, '_blank', 'noopener'); }
    const rec = { at: new Date().toISOString(), by: S.profile?.email || '', via: via === 'wa' ? 'wa' : 'mail', to: via === 'wa' ? c.mobile : c.email, keys };
    await updateDoc(doc(db, 'clients', cid), { reminders: arrayUnion(rec) }); c.reminders = [...(c.reminders || []), rec];
    for (const k of keys) await T.logReminder(cid, k, `Reminder sent on ${via === 'wa' ? 'WhatsApp' : 'email'} to ${rec.to}`);
    document.getElementById('br_' + cid)?.classList.add('sent');
  }),
  clientTab: ({ t }) => { S.consF = ''; S.clientTab = t; S.sel = new Set(); render(); },
  selClear: () => { S.sel = new Set(); render(); },
  moveSel: ({ to }) => {
    const ids = [...S.sel]; if (!ids.length) return;
    guard(async () => { await moveClients(ids, to); S.sel = new Set(); render(); }, `${ids.length} client(s) moved to ${to === 'itr' ? 'Individual – ITR only' : 'Business clients'}`);
  },
  moveOne: ({ to }) => guard(async () => { await moveClients([S.cid], to); render(); }, `Moved to ${to === 'itr' ? 'Individual – ITR only' : 'Business clients'}`),
  newClient: ({ cat } = {}) => { S.client = { id: null, ...(cat === 'itr' ? { category: 'itr', constitution: 'Individual' } : {}) }; S.cid = null; S.creds = []; S.docs = []; S.filings = {}; S.tab = 'master'; S.view = 'client'; render(); },
  delClient: () => {
    if (!confirm(`Delete ${S.client.name} with all logins, documents and filing records? This cannot be undone.`)) return;
    guard(async () => {
      const cid = S.cid;
      for (const sub of ['credentials', 'filings']) for (const d of (await getDocs(collection(db, 'clients', cid, sub))).docs) await deleteDoc(d.ref);
      for (const d of S.docs) await deleteDocFile(cid, d.id);
      for (const u of S.client.portalUsers || []) await updateDoc(doc(db, 'users', u.uid), { role: 'revoked' }).catch(() => {});
      await T.deleteForClient(cid);
      await deleteDoc(doc(db, 'clients', cid));
      await loadClients(); S.view = 'clients'; render();
    }, 'Client deleted');
  },

  /* logins */
  login: ({ id }) => {
    const c = S.creds.find(x => x.id === id); if (!c) return;
    const url = c.url || portalByKey(c.portal).url;
    if (!url) return toast('No login URL saved for this portal. Edit the login and add one.');
    if (extOn()) {
      window.postMessage({ type: 'CAPM_LOGIN', url, username: c.username || '', password: c.password || '', extra: { tan: S.client?.tan || '' } }, location.origin);
      toast('Opening portal — user ID and password will fill. Enter CAPTCHA/OTP to sign in.', 5000);
    } else {
      navigator.clipboard.writeText(c.password || '').catch(() => {});
      window.open(url, '_blank', 'noopener');
      toast(`Password copied. User ID: ${c.username || '—'}`, 6000);
    }
  },
  copy: ({ id, v }) => {
    const c = S.creds.find(x => x.id === id); if (!c) return;
    navigator.clipboard.writeText(v === 'p' ? c.password || '' : c.username || '').then(() => toast(v === 'p' ? 'Password copied' : 'User ID copied'));
  },
  reveal: ({ id }) => { S.reveal.has(id) ? S.reveal.delete(id) : S.reveal.add(id); render(); },
  editReg: ({ id }) => {
    if (!S.cid) return toast('Save the master data first.');
    const r = regsOf(S.client).find(x => x.id === id) || { gstFreq: 'Monthly', status: 'Active' };
    modal(`<h2>${id ? 'Edit' : 'Add'} GST registration</h2>
    <form data-form="saveReg" data-id="${id || ''}" class="grid">
      <label>GSTIN<input name="gstin" class="mono up" value="${esc(r.gstin)}" required maxlength="15" ${id ? '' : 'autofocus'}></label>
      <label>State<input name="state" value="${esc(r.state)}" placeholder="Filled from GSTIN if blank"></label>
      <label>Trade name<input name="tradeName" value="${esc(r.tradeName)}"></label>
      <label>Branch label (optional)<input name="label" value="${esc(r.label)}" placeholder="e.g. Head office, Warehouse"></label>
      <label class="span2">Principal place of business<textarea name="address" rows="2">${esc(r.address)}</textarea></label>
      <label>GST filing<select name="gstFreq">${['Monthly', 'QRMP', 'Composition', 'Not registered'].map(o => `<option ${o === r.gstFreq ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
      <label>Registration date<input type="date" name="regDate" value="${esc(r.regDate)}"></label>
      <label>Status<select name="status">${['Active', 'Cancelled'].map(o => `<option ${o === (r.status || 'Active') ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
      <div class="span2 btns"><button class="primary">Save</button><button type="button" data-act="closeModal">Cancel</button></div>
    </form>`);
  },
  delReg: ({ id }) => {
    const r = regsOf(S.client).find(x => x.id === id);
    if (!confirm(`Delete GSTIN ${r.gstin}? Filing records already marked are kept; its portal logins stay on the Portal logins tab.`)) return;
    guard(() => saveRegs(regsOf(S.client).filter(x => x.id !== id)), 'Registration deleted');
  },
  editCred: ({ id, gstin }) => {
    const c = S.creds.find(x => x.id === id) || { portal: 'gst', gstin: gstin || '' };
    modal(`<h2>${id ? 'Edit' : 'Add'} portal login</h2>
    <form data-form="cred" class="grid" data-id="${id || ''}">
      <label>Portal<select name="portal" data-change="portalPick">${PORTALS.map(p => `<option value="${p.key}" ${p.key === c.portal ? 'selected' : ''}>${p.name}</option>`).join('')}</select></label>
      <label>Label (optional)<input name="label" value="${esc(c.label)}" placeholder="e.g. GST – Delhi branch"></label>
      ${regsOf(S.client).length ? `<label class="span2">GST registration (for GST, E-Way Bill, E-Invoice)<select name="gstin"><option value="">— Not specific to a GSTIN —</option>
        ${regsOf(S.client).map(r => `<option value="${esc(r.gstin)}" ${r.gstin === (c.gstin || (!id && regsOf(S.client).length === 1 ? r.gstin : '')) ? 'selected' : ''}>${esc(regLabel(r))}</option>`).join('')}</select></label>` : ''}
      <label class="span2">Login URL<input name="url" value="${esc(c.url || portalByKey(c.portal).url)}"></label>
      <label>User ID<input name="username" value="${esc(c.username)}" required autocomplete="off"></label>
      <label>Password<input name="password" value="${esc(c.password)}" autocomplete="off"></label>
      <label class="span2">Notes<input name="notes" value="${esc(c.notes)}" placeholder="Registered mobile / email, security question, DSC holder…"></label>
      <div class="span2 btns"><button class="primary">Save</button><button type="button" data-act="closeModal">Cancel</button></div>
    </form>`);
  },
  delCred: ({ id }) => {
    if (!confirm('Delete this login?')) return;
    guard(async () => { await deleteDoc(doc(db, 'clients', S.cid, 'credentials', id)); await openClient(S.cid); render(); }, 'Deleted');
  },
  closeModal,

  /* documents */
  dlDoc: ({ id }) => guard(async () => {
    const meta = S.docs.find(d => d.id === id);
    const chunks = await getDocs(collection(db, 'clients', S.cid, 'docs', id, 'chunks'));
    const b64 = chunks.docs.sort((a, b) => a.id.localeCompare(b.id)).map(d => d.data().d).join('');
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    saveBlob(new Blob([u8], { type: meta.mime }), meta.name);
  }),
  delDoc: ({ id }) => {
    if (!confirm('Delete this document?')) return;
    guard(async () => { await deleteDocFile(S.cid, id); await openClient(S.cid); render(); }, 'Deleted');
  },

  setTrackFrom: () => {
    modal(`<h2>Track compliance from</h2>
      <p class="muted small">Returns due before this date are treated as already filed (before you started using CA Desk) and are not shown as overdue. Returns you marked filed are unaffected.</p>
      <form data-form="trackFrom" class="grid narrow"><label>Date<input type="date" name="d" value="${S.trackFrom}" required></label>
      <div class="span2 btns"><button class="primary">Save</button><button type="button" data-act="closeModal">Cancel</button></div></form>`);
  },
  /* compliance */
  bulkFiled: () => {
    const od = dashRows().filter(r => r.overdue);
    const kinds = [...new Set(od.map(r => r.form.replace(/ — .*$/, '')))].sort();
    modal(`<h2>Mark past returns as filed</h2>
      <p class="muted small">Use this once to clear returns you have already filed outside CA Desk. Only items listed under “Overdue returns” are affected; you can undo any single one from the client's Compliance tab.</p>
      <form data-form="bulkFiled" class="grid">
        <label>Due on or before<input type="date" name="upto" value="${todayISO()}" required></label>
        <label>Filed on (optional)<input type="date" name="filedOn"></label>
        <div class="span2"><h3>Return types</h3><div class="senddocs">${kinds.map(k => `<label class="chk"><input type="checkbox" name="k" value="${esc(k)}" checked> ${esc(k)} <span class="muted tiny">${od.filter(r => r.form.replace(/ — .*$/, '') === k).length}</span></label>`).join('')}</div></div>
        <div class="span2 btns"><button class="primary">Mark as filed</button><button type="button" data-act="closeModal">Cancel</button></div>
      </form>`);
  },
  markFiled: ({ cid, key }) => {
    modal(`<h2>Mark as filed</h2><form data-form="filed" data-cid="${cid}" data-key="${key}" class="grid narrow">
      <label>Filed on<input type="date" name="filedOn" value="${todayISO()}" required></label>
      <label>ARN / acknowledgement no.<input name="ack"></label>
      <label class="span2">Remarks<input name="remarks"></label>
      <div class="span2 btns"><button class="primary">Save</button><button type="button" data-act="closeModal">Cancel</button></div></form>`);
  },
  unfile: ({ key, alt }) => guard(async () => {
    for (const k of [key, alt].filter(Boolean)) {
      await deleteDoc(doc(db, 'clients', S.cid, 'filings', k)); delete S.filings[k]; delete S.allFilings[`${S.cid}|${k}`];
    }
    render();
  }),

  /* access */
  resetPw: ({ email }) => guard(() => sendPasswordResetEmail(auth, email), `Reset link sent to ${email}`),
  revoke: ({ uid }) => { if (confirm('Revoke this client login?')) setAccess(uid, true); },
  restoreAccess: ({ uid }) => setAccess(uid, false),

  /* OCR */
  fromDoc: ({ mode }) => {
    S.pending = { mode };
    modal(`<h2>${mode === 'new' ? 'New client from documents' : 'Fill master data from a document'}</h2>
      <p class="muted small">Upload a GST certificate (REG-06), PAN, TAN letter, Aadhaar, Certificate of Incorporation or LLP deed — PDF or photo. Text is read on this computer; you review every field before it is saved.</p>
      <label class="filebtn">Choose document<input type="file" accept=".pdf,image/*" data-change="ocrFile"></label>
      <div id="ocrStatus" class="muted small"></div><div id="ocrResult"></div>`);
  },

  /* excel */
  xlTemplate: () => {
    const ws = XLSX.utils.aoa_to_sheet([xlHeaders(),
      ['C001', 'ABC Traders', 'ABC', 'Proprietorship', 'ABCPE1234F', '09ABCPE1234F1Z5', '', '', '01-04-1985', '01-07-2017', '', 'abc@example.com', '9876543210', 'Shop 1, Main Road, Dadri', 'Uttar Pradesh', '203207', 'Monthly', 'N', 'N', 'N', 'Y', '', 'Head office'],
      ['C001', 'ABC Traders', 'ABC', 'Proprietorship', 'ABCPE1234F', '07ABCPE1234F1Z9', '', '', '01-04-1985', '15-08-2022', '', 'abc@example.com', '9876543210', 'Plot 4, Okhla Phase 2, New Delhi', 'Delhi', '110020', 'QRMP', 'N', 'N', 'N', 'Y', '', 'Delhi branch — same PAN, second GSTIN']]);
    ws['!cols'] = xlHeaders().map(h => ({ wch: Math.max(12, h.length + 2) }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Clients');
    XLSX.writeFile(wb, 'CA-Desk-client-import-template.xlsx');
  },
  xlImport: () => guard(async () => {
    let n = 0;
    for (const g of S.importRows) {
      busy(true, `Importing ${++n} of ${S.importRows.length}…`);
      let cid = g._match;
      if (cid) {
        const ex = S.clients.find(c => c.id === cid);
        let regs = regsOf(ex).map(r => ({ ...r }));
        for (const r of g.regs) { const e = regs.find(x => x.gstin === r.gstin); if (e) Object.assign(e, r); else regs = mergeReg(regs, r); }
        await tagLegacyCreds(cid, ex);
        await updateDoc(doc(db, 'clients', cid), { ...g.f, ...regMirror(regs), updatedAt: serverTimestamp() });
      } else {
        const regs = g.regs.map(r => ({ id: newRegId(), status: 'Active', ...r }));
        cid = (await addDoc(collection(db, 'clients'), { ...g.f, ...regMirror(regs), portalUsers: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp() })).id;
      }
      if (g.creds.length) {
        const b = writeBatch(db);
        for (const c of g.creds) b.set(doc(db, 'clients', cid, 'credentials', c.gstin ? `${c.portal}@${c.gstin}` : c.portal),
          { ...c, url: portalByKey(c.portal).url, updatedAt: serverTimestamp(), updatedBy: S.profile.email }, { merge: true });
        await b.commit();
      }
    }
    S.importRows = null; await loadClients(); S.view = 'clients'; render();
  }, 'Import complete'),
  exportAll: () => guard(async () => {
    const creds = await getDocs(collectionGroup(db, 'credentials'));
    const byClient = {};
    creds.forEach(d => { (byClient[d.ref.parent.parent.id] ||= []).push(d.data()); });
    const rows = [xlHeaders()];
    for (const c of S.clients) {
      const regs = regsOf(c), cl = byClient[c.id] || [];
      for (const r of regs.length ? regs : [null]) {
        const v = { ...c, ...(r ? { gstin: r.gstin, gstRegDate: r.regDate, gstFreq: r.gstFreq, state: r.state || c.state, address: r.address || c.address, tradeName: r.tradeName || c.tradeName } : { gstin: '', gstFreq: 'Not registered' }) };
        const row = XL_FIELDS.map(([, k]) => BOOLS.has(k) ? (v[k] ? 'Y' : 'N') : (k === 'doi' || k === 'gstRegDate') ? isoToDisp(v[k]) : v[k] || '');
        for (const p of XL_PORTALS) {
          const cr = GST_PORTALS.has(p.key)
            ? cl.find(x => x.portal === p.key && r && (x.gstin === r.gstin || (!x.gstin && regs.length === 1)))
            : cl.find(x => x.portal === p.key);
          row.push(cr?.username || '', cr?.password || '');
        }
        rows.push(row);
      }
    }
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Clients');
    XLSX.writeFile(wb, `CA-Desk-all-clients-${todayISO()}.xlsx`);
  }),
  downloadClient: () => {
    const c = S.client || {};
    const wb = XLSX.utils.book_new();
    const m = [['Field', 'Value'], ...FIELDS.filter(f => (f[0] !== 'notes' || isAdmin()) && !GST_KEYS.has(f[0]))
      .map(([k, l, t]) => [l, t === 'bool' ? (c[k] ? 'Yes' : 'No') : t === 'date' ? isoToDisp(c[k]) : c[k] || ''])];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(m), 'Master data');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['State', 'GSTIN', 'Trade name', 'Address', 'GST filing', 'Registration date', 'Status'],
      ...regsOf(c).map(r => [r.state || stateOf(r.gstin), r.gstin, r.tradeName || '', r.address || '', r.gstFreq || '', isoToDisp(r.regDate), r.status || 'Active'])]), 'GST registrations');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Portal', 'GSTIN', 'Login URL', 'User ID', 'Password', 'Notes'],
      ...S.creds.map(cr => [cr.label || portalByKey(cr.portal).name, cr.gstin || '', cr.url || portalByKey(cr.portal).url, cr.username || '', cr.password || '', cr.notes || ''])]), 'Portal logins');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Due date', 'Return / form', 'Period', 'Status', 'Filed on', 'ARN / Ack'],
      ...complianceRows().map(r => [fmtDate(r.due), r.form, r.period, r.f?.status === 'filed' ? 'Filed' : r.overdue ? 'Overdue' : 'Pending', isoToDisp(r.f?.filedOn), r.f?.ack || ''])]), 'Compliance');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Document', 'Category', 'Uploaded'],
      ...S.docs.map(d => [d.name, d.category, d.uploadedAt ? fmtDate(d.uploadedAt.toDate()) : ''])]), 'Documents');
    XLSX.writeFile(wb, `${(c.name || 'client').replace(/[^\w ]+/g, '').trim()}-${todayISO()}.xlsx`);
  },
};

async function setAccess(uid, revoked) {
  await guard(async () => {
    await updateDoc(doc(db, 'users', uid), { role: revoked ? 'revoked' : 'client' });
    const users = (S.client.portalUsers || []).map(u => u.uid === uid ? { ...u, revoked } : u);
    await updateDoc(doc(db, 'clients', S.cid), { portalUsers: users });
    S.client.portalUsers = users; render();
  }, revoked ? 'Access revoked' : 'Access restored');
}

/* ================= forms ================= */
const F = {
  login: fd => guard(() => signInWithEmailAndPassword(auth, fd.get('email').trim(), fd.get('pw'))),
  setup: fd => guard(async () => {
    settingUp = true;
    try {
      const cred = await createUserWithEmailAndPassword(auth, fd.get('email').trim(), fd.get('pw'));
      const b = writeBatch(db);
      b.set(doc(db, 'users', cred.user.uid), { role: 'admin', name: fd.get('name'), email: cred.user.email, createdAt: serverTimestamp() });
      b.set(doc(db, 'meta', 'setup'), { firmName: fd.get('firm'), createdAt: serverTimestamp() });
      await b.commit();
      settingUp = false; await boot(cred.user);
    } finally { settingUp = false; }
  }, 'Firm set up. Welcome!'),
  master: (fd, form) => guard(async () => {
    const data = {};
    for (const [k, , t] of FIELDS) {
      if (GST_KEYS.has(k)) continue;
      if (t === 'bool') data[k] = form.elements[k].checked;
      else { let v = (fd.get(k) || '').trim(); if (UPPER.has(k)) v = v.toUpperCase(); data[k] = v; }
    }
    if (!data.name) throw new Error('Legal name is required.');
    if (data.pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(data.pan)) throw new Error('PAN format looks wrong (e.g. ABCDE1234F).');
    data.updatedAt = serverTimestamp();
    if (S.cid) await updateDoc(doc(db, 'clients', S.cid), data);
    else { const itr = S.client?.category === 'itr'; S.cid = (await addDoc(collection(db, 'clients'), { ...data, ...regMirror([]), ...(S.client?.category ? { category: S.client.category } : {}), portalUsers: [], createdAt: serverTimestamp() })).id; S.tab = itr ? 'master' : 'gst'; }
    await loadClients(); await openClient(S.cid); render(); autoTasks();
  }, 'Saved'),
  cred: (fd, form) => guard(async () => {
    if (!S.cid) throw new Error('Save the client master data first.');
    const data = Object.fromEntries(['portal', 'label', 'url', 'username', 'password', 'notes', 'gstin'].map(k => [k, (fd.get(k) || '').trim()]));
    if (!GST_PORTALS.has(data.portal)) data.gstin = '';
    data.updatedAt = serverTimestamp(); data.updatedBy = S.profile.email;
    const id = form.dataset.id;
    if (id) await setDoc(doc(db, 'clients', S.cid, 'credentials', id), data, { merge: true });
    else await addDoc(collection(db, 'clients', S.cid, 'credentials'), data);
    closeModal(); await openClient(S.cid); render();
  }, 'Login saved'),
  saveReg: (fd, form) => guard(async () => {
    const id = form.dataset.id;
    const r = Object.fromEntries(['gstin', 'state', 'tradeName', 'label', 'address', 'gstFreq', 'regDate', 'status'].map(k => [k, (fd.get(k) || '').trim()]));
    r.gstin = r.gstin.toUpperCase().replace(/\s/g, '');
    if (!GSTIN_RE.test(r.gstin)) throw new Error('GSTIN format looks wrong (15 characters, e.g. 09ABCDE1234F1Z5).');
    if (S.client.pan && r.gstin.slice(2, 12) !== S.client.pan) { if (!confirm(`This GSTIN is for PAN ${r.gstin.slice(2, 12)}, but the client's PAN is ${S.client.pan}. Save anyway?`)) return; }
    if (!r.state) r.state = stateOf(r.gstin);
    const regs = regsOf(S.client).map(x => ({ ...x }));
    if (regs.some(x => x.gstin === r.gstin && x.id !== id)) throw new Error('This GSTIN is already added for this client.');
    if (id) Object.assign(regs.find(x => x.id === id), r); else regs.push({ id: newRegId(), ...r });
    closeModal(); await saveRegs(regs);
  }, 'GST registration saved'),
  trackFrom: fd => guard(async () => {
    S.trackFrom = fd.get('d'); await updateDoc(doc(db, 'meta', 'setup'), { trackFrom: S.trackFrom }); closeModal(); render();
  }, 'Saved'),
  bulkFiled: fd => guard(async () => {
    const upto = new Date(fd.get('upto') + 'T23:59'), kinds = new Set(fd.getAll('k'));
    const rows = dashRows().filter(r => r.overdue && r.due <= upto && kinds.has(r.form.replace(/ — .*$/, '')));
    if (!rows.length) throw new Error('Nothing matches.');
    if (!confirm(`Mark ${rows.length} return(s) as filed?`)) return;
    let b = writeBatch(db), n = 0;
    for (const r of rows) {
      const data = { status: 'filed', filedOn: fd.get('filedOn') || '', ack: '', remarks: 'Bulk-marked (filed before CA Desk)', by: S.profile.email, at: serverTimestamp() };
      b.set(doc(db, 'clients', r.c.id, 'filings', r.key), data); S.allFilings[`${r.c.id}|${r.key}`] = data;
      if (++n % 400 === 0) { await b.commit(); b = writeBatch(db); }
    }
    await b.commit(); closeModal(); render(); toast(`${n} return(s) marked as filed`);
  }),
  filed: (fd, form) => guard(async () => {
    const { cid, key } = form.dataset;
    const data = { status: 'filed', filedOn: fd.get('filedOn'), ack: fd.get('ack').trim(), remarks: fd.get('remarks').trim(), by: S.profile.email, at: serverTimestamp() };
    await setDoc(doc(db, 'clients', cid, 'filings', key), data);
    S.allFilings[`${cid}|${key}`] = data; if (cid === S.cid) S.filings[key] = data;
    await T.markDone(cid, key, data.ack); // its task (if any) moves to Completed
    closeModal(); render();
  }, 'Marked as filed'),
  newClientLogin: fd => guard(async () => {
    if (!S.cid) throw new Error('Save the client first.');
    const email = fd.get('email').trim();
    const cred = await createUserWithEmailAndPassword(secAuth(), email, fd.get('pw'));
    await signOut(secAuth());
    await setDoc(doc(db, 'users', cred.user.uid), { role: 'client', clientId: S.cid, email, name: S.client.name || '', createdAt: serverTimestamp() });
    await updateDoc(doc(db, 'clients', S.cid), { portalUsers: arrayUnion({ uid: cred.user.uid, email }) });
    await openClient(S.cid, 'access'); await loadClients(); render();
  }, 'Client login created — share the email and temporary password with the client'),
  newStaff: fd => guard(async () => {
    const email = fd.get('email').trim();
    const cred = await createUserWithEmailAndPassword(secAuth(), email, fd.get('pw'));
    await signOut(secAuth());
    await setDoc(doc(db, 'users', cred.user.uid), { role: 'admin', name: fd.get('name').trim(), email, createdAt: serverTimestamp() });
    render(); loadStaff();
  }, 'Staff login created'),
  firm: fd => guard(async () => {
    S.firm = fd.get('firm').trim(); await updateDoc(doc(db, 'meta', 'setup'), { firmName: S.firm }); render(); loadStaff();
  }, 'Saved'),
  applyOcr: (fd, form) => guard(async () => {
    const { res, file, mode } = S.pending;
    const val = k => { let v = (fd.get('f_' + k) || '').trim(); if (UPPER.has(k)) v = v.toUpperCase(); return v; };
    const upd = {};
    for (const k of Object.keys(res.fields)) if (!GST_KEYS.has(k) && form.elements['use_' + k]?.checked && val(k)) upd[k] = val(k);
    let reg = null;
    if (res.fields.gstin && val('gstin')) {
      const g = val('gstin').replace(/\s/g, '');
      if (!GSTIN_RE.test(g)) throw new Error('The GSTIN read from the document looks wrong — correct it in the box.');
      reg = Object.fromEntries(Object.entries({ gstin: g, state: val('state') || stateOf(g), tradeName: val('tradeName'), address: val('address'),
        regDate: res.fields.gstRegDate ? val('gstRegDate') : '', gstFreq: res.fields.gstFreq ? val('gstFreq') : '' }).filter(([, v]) => v));
    }
    let cid = mode === 'update' ? S.cid : (fd.get('target') || null);
    if (cid) {
      const base = cid === S.cid ? S.client : S.clients.find(c => c.id === cid);
      const data = { ...upd, updatedAt: serverTimestamp() };
      if (reg) {
        let regs = regsOf(base).map(r => ({ ...r }));
        const ex = regs.find(r => r.gstin === reg.gstin);
        if (ex) Object.assign(ex, reg); else regs = mergeReg(regs, reg);
        Object.assign(data, regMirror(regs));
      }
      if (reg) await tagLegacyCreds(cid, base);
      await updateDoc(doc(db, 'clients', cid), data);
    } else {
      if (!upd.name) throw new Error('Legal name is needed to create the client.');
      const regs = reg ? [{ id: newRegId(), status: 'Active', gstFreq: 'Monthly', ...reg }] : [];
      cid = (await addDoc(collection(db, 'clients'), { ...upd, ...regMirror(regs), portalUsers: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp() })).id;
    }
    if (form.elements.saveDoc?.checked) await saveFile(cid, file, fd.get('cat'));
    closeModal(); await loadClients(); await openClient(cid, reg ? 'gst' : 'master'); render();
  }, 'Master data updated'),
};

/* ================= change handlers ================= */
const C = {
  cloudImport: el => {
    const f = el.files[0]; if (!f) return;
    if (!confirm('Import this backup into the cloud database? Records with the same IDs will be overwritten.')) return;
    guard(async () => { const n = await importDocs(JSON.parse(await f.text()).docs || {}); await afterImport(n); });
  },
  restore: el => {
    const f = el.files[0]; if (!f) return;
    if (!confirm('Replace ALL data in this browser with the backup? Current data will be overwritten.')) return;
    guard(async () => { await M.importAll(await f.text()); location.reload(); });
  },
  dashDays: el => { S.dashDays = +el.value; render(); },
  selClient: el => { el.checked ? S.sel.add(el.value) : S.sel.delete(el.value); render(); },
  selAll: el => { document.querySelectorAll('[data-change=selClient]').forEach(i => el.checked ? S.sel.add(i.value) : S.sel.delete(i.value)); render(); },
  folderAttach: el => {
    const files = [...el.files]; el.value = '';
    if (!files.length) return;
    let n = 0;
    guard(async () => { n = await folderAttach(files); render(); }).then(() => { if (n) toast(`${n} document(s) attached`); });
  },
  consChange: el => { // keep what was typed, then redraw the form for the new constitution
    const form = el.form, c = S.client ||= {};
    for (const [k, , t] of FIELDS) { const e = form.elements[k]; if (!e) continue; c[k] = t === 'bool' ? e.checked : e.value; }
    render();
  },
  stateF: el => { S.stateF = el.value; S.sel = new Set(); render(); },
  showF: el => { S.showF = el.value; S.sel = new Set(); render(); },
  consF: el => { S.consF = el.value; S.sel = new Set(); render(); },
  compPick: el => { el.checked ? S.compPick.add(el.value) : S.compPick.delete(el.value); el.closest('.cpick')?.classList.toggle('on', el.checked);
    const h = document.querySelector('#compPanel h2 .muted'); if (h) h.textContent = h.textContent.replace(/^\(\d+/, '(' + S.compPick.size); },
  compCons: el => { S.compCons = el.value; render(); },
  dueF: el => { S.dueF[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; render(); },
  portalPick: el => { const u = el.form.elements.url; u.value = portalByKey(el.value).url; },
  uploadDocs: el => guard(async () => {
    const cat = $('#docCat').value;
    for (const f of el.files) { busy(true, `Uploading ${f.name}…`); await saveFile(S.cid, f, cat); }
    await openClient(S.cid); render();
  }, 'Uploaded'),
  ocrFile: async el => {
    const file = el.files[0]; if (!file) return;
    const st = $('#ocrStatus'); st.textContent = 'Reading document…';
    try {
      const res = await extractFromFile(file, m => st.textContent = m);
      S.pending = { ...S.pending, res, file };
      st.textContent = `Detected: ${res.type}. ${Object.keys(res.fields).length} field(s) found.`;
      $('#ocrResult').innerHTML = ocrReview(res);
    } catch (e) { console.error(e); st.textContent = 'Could not read this file: ' + e.message; }
  },
  xlFile: async el => {
    const file = el.files[0]; if (!file) return;
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
      const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false, dateNF: 'dd-mm-yyyy' });
      S.importRows = groupXlRows(raw.map(parseXlRow).filter(r => r.f.name || r.f.pan || r.reg));
      render();
    } catch (e) { toast('Could not read the Excel file: ' + e.message, 6000); }
  },
};

function parseXlRow(row) {
  const byNorm = {}; for (const [k, v] of Object.entries(row)) byNorm[norm(k)] = String(v ?? '').trim();
  const get = h => byNorm[norm(h)] ?? '';
  const f = {};
  for (const [h, k] of XL_FIELDS) {
    let v = get(h) || get(h.replace(/\s*\(.*\)/, ''));
    if (BOOLS.has(k)) { f[k] = /^(y|yes|true|1)$/i.test(v); continue; }
    if (k === 'doi' || k === 'gstRegDate') v = toISO(v);
    if (UPPER.has(k)) v = v.toUpperCase().replace(/\s/g, '');
    if (k === 'gstFreq' && v) v = /qrmp|quarter/i.test(v) ? 'QRMP' : /comp/i.test(v) ? 'Composition' : /not|no/i.test(v) ? 'Not registered' : 'Monthly';
    if (k === 'constitution' && v) v = CONSTS.find(c => norm(c) === norm(v)) || v;
    if (v) f[k] = v;
  }
  if (!f.pan && f.gstin && GSTIN_RE.test(f.gstin)) f.pan = f.gstin.slice(2, 12);
  const reg = f.gstin ? Object.fromEntries(Object.entries({ gstin: f.gstin, state: f.state || stateOf(f.gstin), tradeName: f.tradeName, address: f.address,
    regDate: f.gstRegDate, gstFreq: f.gstFreq || 'Monthly', label: get('Branch') }).filter(([, v]) => v)) : null;
  for (const k of GST_KEYS) delete f[k];
  const creds = [];
  for (const p of XL_PORTALS) {
    const u = get(`${p.short} User`), pw = get(`${p.short} Password`);
    if (u || pw) creds.push({ portal: p.key, username: u, password: pw, gstin: GST_PORTALS.has(p.key) && reg ? reg.gstin : '' });
  }
  return { f, reg, creds };
}
// rows with the same PAN (or client code / name) become one client with several GST registrations
function groupXlRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.f.pan ? 'pan:' + r.f.pan : r.f.code ? 'code:' + r.f.code : 'name:' + norm(r.f.name);
    const g = groups.get(key) || { f: {}, regs: [], creds: [] };
    for (const [k, v] of Object.entries(r.f)) if (g.f[k] === undefined || g.f[k] === '' || g.f[k] === false) g.f[k] = v;
    if (r.reg) g.regs = mergeReg(g.regs, r.reg);
    for (const c of r.creds) if (!g.creds.some(x => x.portal === c.portal && (x.gstin || '') === (c.gstin || ''))) g.creds.push(c);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const gs = g.regs.map(r => r.gstin);
    const m = (g.f.pan && S.clients.find(c => c.pan === g.f.pan))
      || S.clients.find(c => gs.some(x => (c.gstins || []).includes(x) || c.gstin === x))
      || (g.f.code && S.clients.find(c => c.code && c.code === g.f.code));
    g._match = m?.id || null;
  }
  return [...groups.values()];
}

function ocrTarget(res) {
  const { mode } = S.pending, g = res.fields.gstin, pan = res.fields.pan;
  if (mode === 'update') return S.client;
  return S.clients.find(c => (g && ((c.gstins || []).includes(g) || c.gstin === g)) || (pan && c.pan === pan)) || null;
}
function ocrReview(res) {
  const { mode } = S.pending;
  const target = ocrTarget(res);
  const g = res.fields.gstin;
  const reg = g && target ? regsOf(target).find(r => r.gstin === g) : null;
  const REGMAP = { gstin: 'gstin', gstRegDate: 'regDate', gstFreq: 'gstFreq' };
  const cur = k => !target ? '' : REGMAP[k] ? (reg ? reg[REGMAP[k]] || '' : '') : target[k] ?? '';
  const keys = Object.keys(res.fields);
  if (!keys.length) return `<p class="warn">No details could be read. Try a clearer scan or a digitally downloaded PDF. You can still save the document from the client's Documents tab.</p>`;
  const showCur = !!target;
  return `<form data-form="applyOcr">
    ${mode === 'new' && target ? `<p class="warn">A client with this PAN/GSTIN exists: <b>${esc(target.name)}</b>.
      <label class="chk"><input type="checkbox" name="target" value="${target.id}" checked> Add to that client instead of creating a new one</label></p>` : ''}
    ${g ? `<p class="ok small">GSTIN <b class="mono">${esc(g)}</b> (${esc(res.fields.state || stateOf(g))}) will be ${reg ? 'updated in' : 'added to'} the client's GST registrations, with this certificate's trade name, address and date.</p>` : ''}
    <table class="tbl review"><thead><tr><th></th><th>Field</th><th>Read from document</th>${showCur ? '<th>Currently saved</th>' : ''}</tr></thead><tbody>
    ${keys.map(k => {
      const cv = cur(k);
      const differs = cv && String(cv) !== String(res.fields[k]);
      const tag = k === 'people' || k === 'address' ? 'textarea' : 'input';
      const input = tag === 'textarea' ? `<textarea name="f_${k}" rows="2">${esc(res.fields[k])}</textarea>` : `<input name="f_${k}" value="${esc(res.fields[k])}">`;
      return `<tr><td><input type="checkbox" name="use_${k}" ${!cv ? 'checked' : ''}></td><td>${label(k)}${differs ? ' <span class="tag amber">differs</span>' : ''}</td>
        <td>${input}</td>${showCur ? `<td class="muted small">${esc(cv)}</td>` : ''}</tr>`;
    }).join('')}</tbody></table>
    <p class="muted tiny">Ticked fields update the client's master data. The GST registration always takes this certificate's GSTIN, state, trade name, address and date.</p>
    <div class="row wrap">
      <label class="chk"><input type="checkbox" name="saveDoc" checked> Also save this document to the client's Documents as</label>
      <select name="cat">${DOC_CATS.map(c => `<option ${c === res.type ? 'selected' : ''}>${c}</option>`).join('')}</select>
    </div>
    <div class="btns"><button class="primary">${mode === 'new' && !target ? 'Create client' : 'Apply to client'}</button>
      <button type="button" data-act="closeModal">Cancel</button></div>
  </form>`;
}

/* ================= files (stored in Firestore chunks — works on the free plan) ================= */
const CHUNK = 700000;
function fileToB64(file) {
  return new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = bad; r.readAsDataURL(file); });
}
async function saveFile(cid, file, category) {
  if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} is over 10 MB.`);
  const b64 = await fileToB64(file);
  const n = Math.max(1, Math.ceil(b64.length / CHUNK));
  const ref = doc(collection(db, 'clients', cid, 'docs'));
  let batch = writeBatch(db), ops = 0;
  for (let i = 0; i < n; i++) {
    batch.set(doc(db, 'clients', cid, 'docs', ref.id, 'chunks', String(i).padStart(4, '0')), { d: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
    if (++ops >= 6) { await batch.commit(); batch = writeBatch(db); ops = 0; }
  }
  batch.set(ref, { name: file.name, mime: file.type || 'application/octet-stream', size: file.size, category: category || 'Other', chunks: n, uploadedAt: serverTimestamp(), uploadedBy: S.profile.email });
  await batch.commit();
}
// Attach certificates from a picked folder using the prepared list in meta/docImport ({items:[{p,c,t}]}).
async function folderAttach(files) {
  const m = (await getDoc(doc(db, 'meta', 'docImport'))).data();
  const items = m?.items || [];
  if (!items.length) throw new Error('No document list has been prepared yet.');
  const byPath = new Map();
  for (const f of files) {
    const segs = (f.webkitRelativePath || f.name).split('/');
    for (let k = 0; k < Math.min(segs.length, 4); k++) byPath.set(segs.slice(k).join('/').toLowerCase(), f);
  }
  const names = Object.fromEntries(S.clients.map(c => [c.id, c.name]));
  const existing = {};
  let added = 0, had = 0, done = 0; const missing = [], failed = [];
  for (const it of items) {
    done++;
    if (!names[it.c]) continue; // client deleted since the list was made
    const f = byPath.get(it.p.toLowerCase());
    if (!f) { missing.push(it.p); continue; }
    existing[it.c] ||= new Set((await getDocs(collection(db, 'clients', it.c, 'docs'))).docs.map(d => `${d.data().name}|${d.data().size}`));
    if (existing[it.c].has(`${f.name}|${f.size}`)) { had++; continue; }
    busy(true, `Attaching ${done} of ${items.length}: ${names[it.c]} – ${f.name}`);
    try { await saveFile(it.c, f, it.t); existing[it.c].add(`${f.name}|${f.size}`); added++; }
    catch (e) { failed.push(`${it.p} (${niceErr(e)})`); }
  }
  // keep only what is still to do, so the list of file names doesn't linger where client logins could read it
  const left = items.filter(it => names[it.c] && !byPath.get(it.p.toLowerCase()));
  await setDoc(doc(db, 'meta', 'docImport'), { items: left, lastRun: serverTimestamp(), lastAdded: added });
  if (S.cid && S.view === 'client') S.docs = (await getDocs(collection(db, 'clients', S.cid, 'docs'))).docs.map(d => ({ id: d.id, ...d.data() }));
  S.attachReport = `<div class="note"><b>${added}</b> document(s) attached${had ? `, ${had} were already there` : ''}.
    ${missing.length ? `<details><summary>${missing.length} file(s) not found in the chosen folder</summary><div class="tiny mono">${missing.map(esc).join('<br>')}</div></details>` : ''}
    ${failed.length ? `<details open><summary>${failed.length} failed</summary><div class="tiny">${failed.map(esc).join('<br>')}</div></details>` : ''}</div>`;
  return added;
}
async function deleteDocFile(cid, id) {
  for (const c of (await getDocs(collection(db, 'clients', cid, 'docs', id, 'chunks'))).docs) await deleteDoc(c.ref);
  await deleteDoc(doc(db, 'clients', cid, 'docs', id));
}
function saveBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ================= import into cloud ================= */
function readLocalIDB() {
  return new Promise((ok, bad) => {
    const r = indexedDB.open('ca-desk-local', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('docs');
    r.onerror = () => bad(r.error);
    r.onsuccess = () => {
      const out = {}, idb = r.result;
      if (!idb.objectStoreNames.contains('docs')) return ok(out);
      const c = idb.transaction('docs').objectStore('docs').openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { out[cur.key] = cur.value; cur.continue(); } else ok(out); };
      c.onerror = () => bad(c.error);
    };
  });
}
const revive = v => {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    if ('__ts' in v) return new Date(v.__ts);
    if ('seconds' in v && Object.keys(v).length <= 2 && typeof v.seconds === 'number') return new Date(v.seconds * 1000);
    const o = {}; for (const [k, x] of Object.entries(v)) o[k] = revive(x); return o;
  }
  return v;
};
async function importDocs(docs) {
  const keys = Object.keys(docs).filter(k => k.startsWith('clients/') || k.startsWith('tasks/') || k === 'meta/workflow' || k === 'meta/counters');
  let batch = writeBatch(db), n = 0, inBatch = 0;
  for (const k of keys) {
    const data = revive(docs[k]);
    if (/^clients\/[^/]+$/.test(k)) data.portalUsers = [];
    batch.set(doc(db, ...k.split('/')), data);
    n++;
    if (++inBatch >= (k.includes('/chunks/') ? 5 : 200)) { busy(true, `Importing… ${n} of ${keys.length}`); await batch.commit(); batch = writeBatch(db); inBatch = 0; }
  }
  await batch.commit();
  return n;
}
async function afterImport(n) {
  await loadClients(); await loadAllFilings(); await T.load(); render(); loadStaff(); autoTasks();
  toast(`Imported ${n} records into the cloud`, 5000);
}

/* ================= task manager ================= */
const T = initTasks({ S, A, F, C, esc, toast, modal, closeModal, guard, fmtDate, isoToDisp, todayISO, dueItems, isAdmin, $, render: () => render(), db, remindBtns: (...a) => remindBtns(...a),
  fs: { doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc, collection, query, where } });

initDriveImport({ S, A, C, esc, toast, modal, closeModal, db, LOCAL, regsOf, regMirror, mergeReg, newRegId, stateOf, GSTIN_RE,
  saveFile, loadClients, render: () => render(), fs: { doc, getDoc, setDoc, updateDoc, addDoc, collection, serverTimestamp } });
initSend({ S, A, C, esc, toast, modal, closeModal, regsOf, stateOf, isoToDisp, fmtDate, db, saveBlob,
  fs: { doc, getDocs, collection, updateDoc, arrayUnion } });

/* ================= event wiring ================= */
document.addEventListener('click', e => {
  if (!e.target.closest('.gsearch')) $('#gqres')?.classList.remove('show');
  if (e.target.closest('[data-stop]') && !e.target.closest('button')) return;
  const el = e.target.closest('[data-act]'); if (!el) return;
  if (e.target.closest('input,select,textarea') && el.tagName === 'TR') return;
  const fn = A[el.dataset.act]; if (!fn) return;
  e.preventDefault(); fn({ ...el.dataset }, el);
});
document.addEventListener('submit', e => {
  const fn = F[e.target.dataset.form]; if (!fn) return;
  e.preventDefault(); fn(new FormData(e.target), e.target);
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]'); if (el && C[el.dataset.change]) C[el.dataset.change](el, e);
});
document.addEventListener('input', e => {
  if (e.target.id === 'gq') { S.gq = e.target.value; gqResults(); return; }
  if (e.target.id === 'dueQ') {
    S.dueF.q = e.target.value; const pos = e.target.selectionStart; render();
    const s = $('#dueQ'); s.focus(); s.setSelectionRange(pos, pos); return;
  }
  if (e.target.id === 'compQ') {
    S.compQ = e.target.value; const pos = e.target.selectionStart; render();
    const s = $('#compQ'); s.focus(); s.setSelectionRange(pos, pos); return;
  }
  if (e.target.id === 'search') {
    S.search = e.target.value; const pos = e.target.selectionStart; render();
    const s = $('#search'); s.focus(); s.setSelectionRange(pos, pos);
  }
});
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
