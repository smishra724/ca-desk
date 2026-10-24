import { firebaseConfig } from './firebase-config.js';
import { PORTALS, portalByKey } from './portals.js';
import { extractFromFile, toISO } from './extract.js';
import { dueItems, fmtDate } from './compliance.js';

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
const label = k => (FIELDS.find(f => f[0] === k) || [k, k])[1];
const UPPER = new Set(['pan', 'gstin', 'tan', 'cin']);

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
    S.setup = s.exists(); S.firm = s.exists() ? s.data().firmName || '' : '';
  } catch { S.setup = true; }
  document.title = S.firm ? `${S.firm} · CA Desk` : 'CA Desk';
  if (!u) { S.profile = null; return renderLogin(); }
  const p = await getDoc(doc(db, 'users', u.uid)).catch(() => null);
  const role = p?.exists() ? p.data().role : null;
  if (role !== 'admin' && role !== 'client') return renderNoAccess(u);
  S.profile = { uid: u.uid, email: u.email, ...p.data() };
  if (isAdmin()) { await loadClients(); await loadAllFilings(); S.view = 'dashboard'; }
  else { await openClient(S.profile.clientId, 'master'); }
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
    .sort((a, b) => PORTALS.findIndex(p => p.key === a.portal) - PORTALS.findIndex(p => p.key === b.portal));
  S.docs = dc.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.uploadedAt?.seconds || 0) - (a.uploadedAt?.seconds || 0));
  S.filings = {}; fl.forEach(d => S.filings[d.id] = d.data());
  S.view = 'client';
}

/* ================= rendering ================= */
function render() {
  if (!S.profile) return;
  const nav = isAdmin() ? [['dashboard', 'Dashboard'], ['clients', 'Clients'], ['import', 'Excel import'], ['settings', 'Settings']]
    .map(([v, l]) => `<button class="nav ${S.view === v ? 'on' : ''}" data-act="go" data-v="${v}">${l}</button>`).join('') : '';
  $('#app').innerHTML = `
  <header class="top">
    <div class="brand"><span class="logo sm">₹</span>${esc(S.firm || 'CA Desk')}</div>
    <nav>${nav}</nav>
    <div class="who">${LOCAL ? '<span class="tag amber">Local mode</span>' : `<span class="muted small">${esc(S.profile.email)}</span><button class="ghost" data-act="logout">Sign out</button>`}</div>
  </header>
  ${LOCAL ? `<div class="localbar">Data is saved in this browser on this computer only. Take a backup from <a href="#" data-act="go" data-v="settings">Settings</a> regularly. Client and staff logins switch on once Firebase is connected.</div>` : ''}
  <main>${body()}</main>`;
}
function body() {
  switch (S.view) {
    case 'dashboard': return vDashboard();
    case 'clients': return vClients();
    case 'client': return vClient();
    case 'import': return vImport();
    case 'settings': return vSettings();
  }
  return '';
}

/* ---------- dashboard ---------- */
function dashRows() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const from = new Date(today); from.setDate(from.getDate() - 90);
  const to = new Date(today); to.setDate(to.getDate() + S.dashDays);
  const rows = [];
  for (const c of S.clients) {
    for (const it of dueItems(c, from, to)) {
      const f = S.allFilings[`${c.id}|${it.key}`];
      if (f?.status === 'filed') continue;
      if (it.note === 'Optional' && it.due < today) continue;
      rows.push({ ...it, c, overdue: it.due < today });
    }
  }
  return rows.sort((a, b) => a.due - b.due);
}
function vDashboard() {
  const rows = dashRows();
  const od = rows.filter(r => r.overdue), up = rows.filter(r => !r.overdue);
  const week = up.filter(r => (r.due - new Date()) / 864e5 <= 7);
  const tbl = list => list.length ? `<table class="tbl"><thead><tr><th>Due</th><th>Client</th><th>Return / form</th><th>Period</th><th></th></tr></thead><tbody>
    ${list.map(r => `<tr class="${r.overdue ? 'od' : ''}"><td class="nowrap">${fmtDate(r.due)}</td>
      <td><a href="#" data-act="open" data-id="${r.c.id}" data-tab="compliance">${esc(r.c.name || r.c.tradeName || '—')}</a></td>
      <td>${esc(r.form)}${r.note ? ` <span class="tag">${esc(r.note)}</span>` : ''}</td><td>${esc(r.period)}</td>
      <td><button class="sm" data-act="markFiled" data-cid="${r.c.id}" data-key="${r.key}">Mark filed</button></td></tr>`).join('')}
    </tbody></table>` : '<p class="muted empty">Nothing here.</p>';
  return `
  <div class="stats">
    <div class="stat"><b>${S.clients.length}</b><span>Clients</span></div>
    <div class="stat red"><b>${od.length}</b><span>Overdue (last 90 days)</span></div>
    <div class="stat amber"><b>${week.length}</b><span>Due in 7 days</span></div>
    <div class="stat"><b>${up.length}</b><span>Due in ${S.dashDays} days</span></div>
  </div>
  <section class="card"><h2>Overdue</h2>${tbl(od)}</section>
  <section class="card"><div class="row-between"><h2>Upcoming</h2>
    <select data-change="dashDays">${[15, 30, 45, 60, 90].map(d => `<option ${d === S.dashDays ? 'selected' : ''} value="${d}">Next ${d} days</option>`).join('')}</select></div>
    ${tbl(up)}
    <p class="muted small">Statutory due dates. Check CBIC / CBDT / MCA notifications for extensions.</p></section>`;
}

/* ---------- clients list ---------- */
function vClients() {
  const q = S.search.toLowerCase();
  const list = S.clients.filter(c => !q || [c.name, c.tradeName, c.pan, c.gstin, c.code, c.mobile].some(v => (v || '').toLowerCase().includes(q)));
  return `
  <section class="card">
    <div class="row-between wrap">
      <h2>Clients <span class="muted">(${S.clients.length})</span></h2>
      <div class="btns">
        <button class="primary" data-act="fromDoc" data-mode="new">+ New client from documents</button>
        <button data-act="newClient">+ Blank client</button>
        <button data-act="exportAll">Export all (Excel)</button>
      </div>
    </div>
    <input id="search" class="search" placeholder="Search name, PAN, GSTIN, code, mobile…" value="${esc(S.search)}">
    <table class="tbl"><thead><tr><th>Code</th><th>Name</th><th>Constitution</th><th>PAN</th><th>GSTIN</th><th>Client login</th></tr></thead><tbody>
    ${list.map(c => `<tr class="click" data-act="open" data-id="${c.id}"><td>${esc(c.code)}</td>
      <td><b>${esc(c.name || '—')}</b>${c.tradeName ? `<div class="muted small">${esc(c.tradeName)}</div>` : ''}</td>
      <td>${esc(c.constitution)}</td><td class="mono">${esc(c.pan)}</td><td class="mono">${esc(c.gstin)}</td>
      <td>${(c.portalUsers || []).filter(p => !p.revoked).length ? '<span class="tag green">Active</span>' : '<span class="tag">—</span>'}</td></tr>`).join('')
    || `<tr><td colspan="6" class="muted empty">No clients yet. Upload a GST certificate or PAN to create one, or import your Excel list.</td></tr>`}
    </tbody></table>
  </section>`;
}

/* ---------- single client ---------- */
function vClient() {
  const c = S.client || {};
  const tabs = [['master', 'Master data'], ['logins', 'Portal logins'], ['docs', 'Documents'], ['compliance', 'Compliance'], ...(isAdmin() ? [['access', 'Client access']] : [])];
  return `
  ${isAdmin() ? `<button class="link back" data-act="go" data-v="clients">← All clients</button>` : ''}
  <section class="card head">
    <div class="row-between wrap">
      <div><h1>${esc(c.name || 'New client')}</h1>
        <div class="chips">${c.tradeName ? `<span>${esc(c.tradeName)}</span>` : ''}${c.constitution ? `<span>${esc(c.constitution)}</span>` : ''}
        ${c.pan ? `<span class="mono">PAN ${esc(c.pan)}</span>` : ''}${c.gstin ? `<span class="mono">GSTIN ${esc(c.gstin)}</span>` : ''}</div></div>
      <div class="btns">
        ${isAdmin() ? `<button class="primary" data-act="fromDoc" data-mode="update">Fill from document</button>` : ''}
        <button data-act="downloadClient">Download my data (Excel)</button>
      </div>
    </div>
    ${S.creds.length ? `<div class="quick"><span class="muted small">Quick login:</span>
      ${S.creds.map(cr => `<button class="sm pill" data-act="login" data-id="${cr.id}">${esc(portalByKey(cr.portal).short)} ↗</button>`).join('')}</div>` : ''}
  </section>
  <div class="tabs">${tabs.map(([t, l]) => `<button class="${S.tab === t ? 'on' : ''}" data-act="tab" data-t="${t}">${l}</button>`).join('')}</div>
  <section class="card">${({ master: tMaster, logins: tLogins, docs: tDocs, compliance: tCompliance, access: tAccess })[S.tab]?.() || ''}</section>`;
}

function fieldInput([k, l, type, opts], v) {
  if (type === 'bool') return `<label class="chk"><input type="checkbox" name="${k}" ${v ? 'checked' : ''}> ${l}</label>`;
  let inp;
  if (type === 'select') inp = `<select name="${k}"><option value=""></option>${opts.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
  else if (type === 'textarea') inp = `<textarea name="${k}" rows="3">${esc(v)}</textarea>`;
  else if (type === 'date') inp = `<input type="date" name="${k}" value="${esc(v)}">`;
  else inp = `<input name="${k}" value="${esc(v)}" ${UPPER.has(k) ? 'class="mono up"' : ''}>`;
  return `<label class="${type === 'textarea' ? 'span2' : ''}">${l}${inp}</label>`;
}
function tMaster() {
  const c = S.client || {};
  if (!isAdmin()) {
    return `<dl class="dl">${FIELDS.filter(f => c[f[0]] !== undefined && c[f[0]] !== '' && f[0] !== 'notes').map(([k, l, t]) => `<dt>${l}</dt><dd>${
      t === 'bool' ? (c[k] ? 'Yes' : 'No') : t === 'date' ? isoToDisp(c[k]) : k === 'aadhaar' ? 'XXXX XXXX ' + esc(String(c[k]).slice(-4)) : esc(c[k]).replace(/\n/g, '<br>')}</dd>`).join('')}</dl>`;
  }
  return `<form data-form="master" class="grid">
    ${FIELDS.filter(f => f[2] !== 'bool').map(f => fieldInput(f, c[f[0]])).join('')}
    <div class="span2 bools">${FIELDS.filter(f => f[2] === 'bool').map(f => fieldInput(f, c[f[0]])).join('')}</div>
    <div class="span2 btns"><button class="primary">Save master data</button>
      ${S.client?.createdAt ? `<button type="button" class="danger" data-act="delClient">Delete client</button>` : ''}</div>
  </form>`;
}

function tLogins() {
  const rows = S.creds.map(cr => {
    const p = portalByKey(cr.portal), shown = S.reveal.has(cr.id);
    return `<div class="cred">
      <div class="cred-h"><b>${esc(cr.label || p.name)}</b>
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
  <div class="row-between wrap"><h2>Documents</h2></div>
  ${isAdmin() ? `<div class="upload">
    <select id="docCat">${DOC_CATS.map(c => `<option>${c}</option>`).join('')}</select>
    <label class="filebtn">Upload files<input type="file" multiple data-change="uploadDocs" accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.doc,.docx,.zip,.json"></label>
    <span class="muted small">Max 10 MB per file.</span></div>` : ''}
  <table class="tbl"><thead><tr><th>Document</th><th>Category</th><th>Size</th><th>Uploaded</th><th></th></tr></thead><tbody>
  ${S.docs.map(d => `<tr><td>${esc(d.name)}</td><td>${esc(d.category)}</td><td class="nowrap">${(d.size / 1024).toFixed(0)} KB</td>
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
  return dueItems(S.client || {}, from, to).map(it => ({ ...it, f: S.filings[it.key], overdue: it.due < today }));
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
      <td>${isAdmin() ? (filed ? `<button class="sm" data-act="unfile" data-key="${r.key}">Undo</button>`
        : `<button class="sm" data-act="markFiled" data-cid="${S.cid}" data-key="${r.key}">Mark filed</button>`) : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="5" class="muted empty">Fill GSTIN, constitution and the applicability ticks in master data to see due dates.</td></tr>'}
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
      <li><button data-act="xlTemplate">Download the template</button> — one row per client (one row per GSTIN if a PAN has several registrations).</li>
      <li>Fill master data and the user ID / password columns for each portal. Leave blanks where not applicable.</li>
      <li>Upload it below. Existing clients are matched by GSTIN, then PAN, then client code, and updated; others are created.</li>
    </ol>
    <label class="filebtn">Choose Excel file<input type="file" accept=".xlsx,.xls,.csv" data-change="xlFile"></label>
    <p class="muted small">Tip: “Export all” on the Clients page produces the same format — use it as a backup or to bulk-edit and re-import.</p>
    ${r ? `<hr><p><b>${r.length}</b> rows read: <b>${r.filter(x => x._match).length}</b> will update existing clients, <b>${r.filter(x => !x._match).length}</b> will be new.</p>
      <table class="tbl"><thead><tr><th>Name</th><th>PAN</th><th>GSTIN</th><th>Logins</th><th>Action</th></tr></thead><tbody>
      ${r.slice(0, 200).map(x => `<tr><td>${esc(x.f.name)}</td><td class="mono">${esc(x.f.pan)}</td><td class="mono">${esc(x.f.gstin)}</td>
        <td>${x.creds.map(c => portalByKey(c.portal).short).join(', ')}</td><td>${x._match ? 'Update' : 'New'}</td></tr>`).join('')}
      </tbody></table>
      <button class="primary" data-act="xlImport">Import ${r.length} rows</button>` : ''}
  </section>`;
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
    <h2>Backup &amp; restore</h2>
    ${LOCAL ? '<p class="muted small">In local mode everything lives in this browser. Download a backup regularly and keep it safe — clearing browser data deletes it. The backup also moves your data to another computer or into Firebase later.</p>'
      : '<p class="muted small">Your data is stored in Firebase. A backup file is still useful as an offline copy.</p>'}
    <div class="btns"><button class="primary" data-act="backup">Download full backup</button>
    ${LOCAL ? '<label class="filebtn ghostbtn">Restore from backup<input type="file" accept=".json" data-change="restore"></label>' : ''}</div>
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
  backup: () => guard(async () => {
    let json;
    if (LOCAL) json = M.exportAll();
    else {
      const docs = {};
      const add = snap => snap.forEach(d => docs[d.ref.path] = d.data());
      add(await getDocs(collection(db, 'clients')));
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
  go: ({ v }) => { S.view = v; S.importRows = v === 'import' ? S.importRows : null; render(); if (v === 'settings') loadStaff(); },
  open: ({ id, tab }) => guard(async () => { await openClient(id, tab || 'master'); render(); }),
  tab: ({ t }) => { S.tab = t; render(); },
  newClient: () => { S.client = { id: null }; S.cid = null; S.creds = []; S.docs = []; S.filings = {}; S.tab = 'master'; S.view = 'client'; render(); },
  delClient: () => {
    if (!confirm(`Delete ${S.client.name} with all logins, documents and filing records? This cannot be undone.`)) return;
    guard(async () => {
      const cid = S.cid;
      for (const sub of ['credentials', 'filings']) for (const d of (await getDocs(collection(db, 'clients', cid, sub))).docs) await deleteDoc(d.ref);
      for (const d of S.docs) await deleteDocFile(cid, d.id);
      for (const u of S.client.portalUsers || []) await updateDoc(doc(db, 'users', u.uid), { role: 'revoked' }).catch(() => {});
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
  editCred: ({ id }) => {
    const c = S.creds.find(x => x.id === id) || { portal: 'gst' };
    modal(`<h2>${id ? 'Edit' : 'Add'} portal login</h2>
    <form data-form="cred" class="grid" data-id="${id || ''}">
      <label>Portal<select name="portal" data-change="portalPick">${PORTALS.map(p => `<option value="${p.key}" ${p.key === c.portal ? 'selected' : ''}>${p.name}</option>`).join('')}</select></label>
      <label>Label (optional)<input name="label" value="${esc(c.label)}" placeholder="e.g. GST – Delhi branch"></label>
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

  /* compliance */
  markFiled: ({ cid, key }) => {
    modal(`<h2>Mark as filed</h2><form data-form="filed" data-cid="${cid}" data-key="${key}" class="grid narrow">
      <label>Filed on<input type="date" name="filedOn" value="${todayISO()}" required></label>
      <label>ARN / acknowledgement no.<input name="ack"></label>
      <label class="span2">Remarks<input name="remarks"></label>
      <div class="span2 btns"><button class="primary">Save</button><button type="button" data-act="closeModal">Cancel</button></div></form>`);
  },
  unfile: ({ key }) => guard(async () => {
    await deleteDoc(doc(db, 'clients', S.cid, 'filings', key)); delete S.filings[key]; delete S.allFilings[`${S.cid}|${key}`]; render();
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
    const ws = XLSX.utils.aoa_to_sheet([xlHeaders(), ['C001', 'ABC Traders', 'ABC', 'Proprietorship', 'ABCPE1234F', '09ABCPE1234F1Z5', '', '', '01-04-1985', '01-07-2017', '', 'abc@example.com', '9876543210', 'Shop 1, Main Road, Dadri', 'Uttar Pradesh', '203207', 'Monthly', 'N', 'N', 'N', 'Y', '', '']]);
    ws['!cols'] = xlHeaders().map(h => ({ wch: Math.max(12, h.length + 2) }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Clients');
    XLSX.writeFile(wb, 'CA-Desk-client-import-template.xlsx');
  },
  xlImport: () => guard(async () => {
    let n = 0;
    for (const r of S.importRows) {
      busy(true, `Importing ${++n} of ${S.importRows.length}…`);
      let cid = r._match;
      if (cid) await updateDoc(doc(db, 'clients', cid), { ...r.f, updatedAt: serverTimestamp() });
      else cid = (await addDoc(collection(db, 'clients'), { ...r.f, portalUsers: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp() })).id;
      if (r.creds.length) {
        const b = writeBatch(db);
        for (const c of r.creds) b.set(doc(db, 'clients', cid, 'credentials', c.portal), { ...c, url: portalByKey(c.portal).url, updatedAt: serverTimestamp(), updatedBy: S.profile.email }, { merge: true });
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
      const row = XL_FIELDS.map(([, k]) => BOOLS.has(k) ? (c[k] ? 'Y' : 'N') : (k === 'doi' || k === 'gstRegDate') ? isoToDisp(c[k]) : c[k] || '');
      for (const p of XL_PORTALS) { const cr = (byClient[c.id] || []).find(x => x.portal === p.key); row.push(cr?.username || '', cr?.password || ''); }
      rows.push(row);
    }
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Clients');
    XLSX.writeFile(wb, `CA-Desk-all-clients-${todayISO()}.xlsx`);
  }),
  downloadClient: () => {
    const c = S.client || {};
    const wb = XLSX.utils.book_new();
    const m = [['Field', 'Value'], ...FIELDS.filter(f => f[0] !== 'notes' || isAdmin())
      .map(([k, l, t]) => [l, t === 'bool' ? (c[k] ? 'Yes' : 'No') : t === 'date' ? isoToDisp(c[k]) : c[k] || ''])];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(m), 'Master data');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Portal', 'Login URL', 'User ID', 'Password', 'Notes'],
      ...S.creds.map(cr => [cr.label || portalByKey(cr.portal).name, cr.url || portalByKey(cr.portal).url, cr.username || '', cr.password || '', cr.notes || ''])]), 'Portal logins');
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
      if (t === 'bool') data[k] = form.elements[k].checked;
      else { let v = (fd.get(k) || '').trim(); if (UPPER.has(k)) v = v.toUpperCase(); data[k] = v; }
    }
    if (!data.name) throw new Error('Legal name is required.');
    if (data.pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(data.pan)) throw new Error('PAN format looks wrong (e.g. ABCDE1234F).');
    if (data.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(data.gstin)) throw new Error('GSTIN format looks wrong.');
    data.updatedAt = serverTimestamp();
    if (S.cid) await updateDoc(doc(db, 'clients', S.cid), data);
    else S.cid = (await addDoc(collection(db, 'clients'), { ...data, portalUsers: [], createdAt: serverTimestamp() })).id;
    await loadClients(); await openClient(S.cid); render();
  }, 'Saved'),
  cred: (fd, form) => guard(async () => {
    if (!S.cid) throw new Error('Save the client master data first.');
    const data = Object.fromEntries(['portal', 'label', 'url', 'username', 'password', 'notes'].map(k => [k, (fd.get(k) || '').trim()]));
    data.updatedAt = serverTimestamp(); data.updatedBy = S.profile.email;
    const id = form.dataset.id;
    if (id) await setDoc(doc(db, 'clients', S.cid, 'credentials', id), data, { merge: true });
    else await addDoc(collection(db, 'clients', S.cid, 'credentials'), data);
    closeModal(); await openClient(S.cid); render();
  }, 'Login saved'),
  filed: (fd, form) => guard(async () => {
    const { cid, key } = form.dataset;
    const data = { status: 'filed', filedOn: fd.get('filedOn'), ack: fd.get('ack').trim(), remarks: fd.get('remarks').trim(), by: S.profile.email, at: serverTimestamp() };
    await setDoc(doc(db, 'clients', cid, 'filings', key), data);
    S.allFilings[`${cid}|${key}`] = data; if (cid === S.cid) S.filings[key] = data;
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
    const upd = {};
    for (const k of Object.keys(res.fields)) if (form.elements['use_' + k]?.checked) {
      let v = (fd.get('f_' + k) || '').trim(); if (UPPER.has(k)) v = v.toUpperCase();
      if (v) upd[k] = v;
    }
    let cid = mode === 'update' ? S.cid : null;
    if (mode === 'new' && fd.get('target')) cid = fd.get('target');
    if (cid) { if (Object.keys(upd).length) await updateDoc(doc(db, 'clients', cid), { ...upd, updatedAt: serverTimestamp() }); }
    else {
      if (!upd.name) throw new Error('Legal name is needed to create the client.');
      cid = (await addDoc(collection(db, 'clients'), { gstFreq: upd.gstin ? 'Monthly' : 'Not registered', ...upd, portalUsers: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp() })).id;
    }
    if (form.elements.saveDoc?.checked) await saveFile(cid, file, fd.get('cat'));
    closeModal(); await loadClients(); await openClient(cid, 'master'); render();
  }, 'Master data updated'),
};

/* ================= change handlers ================= */
const C = {
  restore: el => {
    const f = el.files[0]; if (!f) return;
    if (!confirm('Replace ALL data in this browser with the backup? Current data will be overwritten.')) return;
    guard(async () => { await M.importAll(await f.text()); location.reload(); });
  },
  dashDays: el => { S.dashDays = +el.value; render(); },
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
      S.importRows = raw.map(parseXlRow).filter(r => r.f.name || r.f.pan || r.f.gstin);
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
  const creds = [];
  for (const p of XL_PORTALS) {
    const u = get(`${p.short} User`), pw = get(`${p.short} Password`);
    if (u || pw) creds.push({ portal: p.key, username: u, password: pw });
  }
  const match = (f.gstin && S.clients.find(c => c.gstin === f.gstin))
    || (f.pan && !f.gstin && S.clients.find(c => c.pan === f.pan && !c.gstin))
    || (f.code && S.clients.find(c => c.code && c.code === f.code));
  return { f, creds, _match: match?.id || null };
}

function ocrReview(res) {
  const { mode } = S.pending;
  const cur = mode === 'update' ? S.client || {} : {};
  const keys = Object.keys(res.fields);
  // When creating, offer to merge into an existing client with the same PAN/GSTIN
  const dupe = mode === 'new' && S.clients.find(c => (res.fields.gstin && c.gstin === res.fields.gstin) || (res.fields.pan && c.pan === res.fields.pan));
  if (!keys.length) return `<p class="warn">No details could be read. Try a clearer scan or a digitally downloaded PDF. You can still save the document from the client's Documents tab.</p>`;
  return `<form data-form="applyOcr">
    ${dupe ? `<p class="warn">A client with this PAN/GSTIN exists: <b>${esc(dupe.name)}</b>.
      <label class="chk"><input type="checkbox" name="target" value="${dupe.id}" checked> Update that client instead of creating a new one</label></p>` : ''}
    <table class="tbl review"><thead><tr><th></th><th>Field</th><th>Read from document</th>${mode === 'update' ? '<th>Currently saved</th>' : ''}</tr></thead><tbody>
    ${keys.map(k => {
      const differs = cur[k] && String(cur[k]) !== String(res.fields[k]);
      const tag = k === 'people' || k === 'address' ? 'textarea' : 'input';
      const input = tag === 'textarea' ? `<textarea name="f_${k}" rows="2">${esc(res.fields[k])}</textarea>` : `<input name="f_${k}" value="${esc(res.fields[k])}">`;
      return `<tr><td><input type="checkbox" name="use_${k}" ${!cur[k] ? 'checked' : ''}></td><td>${label(k)}${differs ? ' <span class="tag amber">differs</span>' : ''}</td>
        <td>${input}</td>${mode === 'update' ? `<td class="muted small">${esc(cur[k] ?? '')}</td>` : ''}</tr>`;
    }).join('')}</tbody></table>
    <div class="row wrap">
      <label class="chk"><input type="checkbox" name="saveDoc" checked> Also save this document to the client's Documents as</label>
      <select name="cat">${DOC_CATS.map(c => `<option ${c === res.type ? 'selected' : ''}>${c}</option>`).join('')}</select>
    </div>
    <div class="btns"><button class="primary">${mode === 'new' ? 'Create / update client' : 'Apply ticked fields'}</button>
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
async function deleteDocFile(cid, id) {
  for (const c of (await getDocs(collection(db, 'clients', cid, 'docs', id, 'chunks'))).docs) await deleteDoc(c.ref);
  await deleteDoc(doc(db, 'clients', cid, 'docs', id));
}
function saveBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ================= event wiring ================= */
document.addEventListener('click', e => {
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
  if (e.target.id === 'search') {
    S.search = e.target.value; const pos = e.target.selectionStart; render();
    const s = $('#search'); s.focus(); s.setSelectionRange(pos, pos);
  }
});
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
