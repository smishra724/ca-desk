// Import from Google Drive: reads a folder of client folders, pulls master data out of the KYC documents
// (GST certificate, PAN, TAN, Aadhaar, incorporation certificate, deed) and creates / updates clients.
// Runs entirely in the browser with a read-only Drive token the user grants through Google sign-in.

import { extractText, parse } from './extract.js';

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const KYC_NAME = /gst|reg[\s_-]?0?6|regist|pan|tan|aadh?a+r|uid|coi|incorp|certif|moa|aoa|deed|llp|partnership|udyam|msme|kyc|cin|din|elec|bill|rent|noc/i;
const SKIP_FOLDER = /debit|credit\s*card|\bcc\b|cards?/i;   // card details are never imported
const SKIP_FILE = /^\._|\.ds_store$|card|cvv/i;
const READABLE = f => /pdf$/i.test(f.mimeType) || /^image\/(jpe?g|png|webp)$/i.test(f.mimeType);
const CONTAINER = /^(clients?|income\s*tax\s*return\s*clients?|itr\s*clients?)$/i;
const ENTITY_TYPES = new Set(['GST Certificate', 'Certificate of Incorporation', 'LLP Incorporation', 'TAN Allotment', 'Partnership Deed / LLP Agreement']);
const RANK = { 'GST Certificate': 5, 'Certificate of Incorporation': 4, 'LLP Incorporation': 4, 'TAN Allotment': 3, 'Partnership Deed / LLP Agreement': 2, 'PAN Card': 1, 'Aadhaar': 0, 'Other': -1 };

export function initDriveImport(ctx) {
  const { S, A, C, esc, toast, modal, closeModal, db, fs, LOCAL,
    regsOf, regMirror, mergeReg, newRegId, stateOf, GSTIN_RE, saveFile, loadClients, render } = ctx;
  const { doc, getDoc, setDoc, updateDoc, addDoc, collection, serverTimestamp } = fs;
  let token = null, googleEmail = '', plan = null, stop = false;

  /* ---------- Google connection: Google Identity Services token (read-only Drive). It does not sign in
     to CA Desk, so it never touches CA Desk logins. ---------- */
  const CLIENT_ID = '849362120388-5g7nrke9qit6gmmp4tpra5td0p4o49gh.apps.googleusercontent.com';
  let gisReady = null, tokenClient = null;
  function loadGis() {
    return gisReady ||= new Promise((ok, bad) => {
      if (window.google?.accounts?.oauth2) return ok();
      const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => ok(); s.onerror = () => bad(new Error('Could not load Google sign-in.')); document.head.appendChild(s);
    });
  }
  // must be called straight from a click so the Google window is allowed to open
  function connect() {
    return new Promise((ok, bad) => {
      if (!window.google?.accounts?.oauth2) return bad(new Error('Google sign-in is still loading — click again in a second.'));
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: 'https://www.googleapis.com/auth/drive.readonly', prompt: 'select_account',
        callback: async r => {
          if (r.error) return bad(new Error(r.error === 'access_denied' ? 'Drive access was not allowed.' : r.error));
          token = r.access_token;
          try { googleEmail = (await api('about', { fields: 'user(emailAddress)' })).user.emailAddress; } catch { googleEmail = ''; }
          ok();
        },
        error_callback: e => bad(new Error(e?.type === 'popup_closed' ? 'The Google window was closed.' : 'Google sign-in failed: ' + (e?.message || e?.type))),
      });
      tokenClient.requestAccessToken();
    });
  }
  async function api(path, params = {}, raw = false) {
    const url = `${API}/${path}?${new URLSearchParams({ supportsAllDrives: 'true', ...params })}`;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (r.status === 401) { token = null; throw new Error('Google Drive access expired — click Connect again.'); }
    if (r.status === 403) {
      const t = await r.text();
      if (/has not been used|is disabled|accessNotConfigured/i.test(t)) throw new Error('Google Drive API is not enabled for this Firebase project yet.');
      throw new Error('Drive refused access: ' + t.slice(0, 200));
    }
    if (!r.ok) throw new Error(`Drive error ${r.status}`);
    return raw ? r.blob() : r.json();
  }
  async function children(id) {
    const out = []; let pageToken;
    do {
      const j = await api('files', { q: `'${id}' in parents and trashed=false`, fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)',
        pageSize: '1000', includeItemsFromAllDrives: 'true', ...(pageToken ? { pageToken } : {}) });
      out.push(...j.files); pageToken = j.nextPageToken;
    } while (pageToken);
    return out;
  }
  async function walk(id, depth = 0, path = '') {
    const kids = await children(id), files = [];
    for (const k of kids) {
      if (k.mimeType === FOLDER) { if (depth < 4 && !SKIP_FOLDER.test(k.name)) files.push(...await walk(k.id, depth + 1, path + k.name + '/')); }
      else if (!SKIP_FILE.test(k.name)) files.push({ ...k, path: path + k.name });
    }
    return files;
  }
  const folderId = s => (String(s).match(/folders\/([\w-]{10,})/) || String(s).match(/id=([\w-]{10,})/) || [, String(s).trim()])[1];

  /* ---------- UI ---------- */
  A.driveOpen = async () => {
    if (LOCAL) return toast('Connect Firebase first — Drive import saves straight into your cloud database.');
    const m = await getDoc(doc(db, 'meta', 'drive')).catch(() => null);
    const last = m?.exists() ? m.data().folder || '' : '';
    plan = null; loadGis().catch(() => {});
    modal(`<h2>Import clients from Google Drive</h2>
      <p class="muted small">Point to a folder that holds one sub-folder per client (e.g. <b>DATA MANAGEMENT</b>). CA Desk reads the GST certificates, PAN, TAN, Aadhaar,
      incorporation certificates and deeds in each folder, fills the master data and GST registrations, and copies those KYC documents into the client's Documents.
      Drive access is read-only; nothing in Drive is changed. Folders about debit / credit cards are always skipped.</p>
      <div class="grid">
        <label class="span2">Drive folder link or ID<input id="drvFolder" value="${esc(last)}" placeholder="https://drive.google.com/drive/folders/…"></label>
      </div>
      <div class="btns"><button class="primary" data-act="driveScan">${token ? 'Scan folder' : 'Connect Google Drive & scan'}</button>
        <button data-act="closeModal">Close</button></div>
      <div id="drvOut"></div>`);
  };

  A.driveScan = async () => {
    const out = document.getElementById('drvOut');
    const id = folderId(document.getElementById('drvFolder').value);
    if (!id) return toast('Paste the Drive folder link first.');
    try {
      if (!token) { out.innerHTML = '<p class="muted">Waiting for Google sign-in…</p>'; await connect(); }
      out.innerHTML = `<p class="muted">Connected as ${esc(googleEmail)}. Scanning folders…</p>`;
      await setDoc(doc(db, 'meta', 'drive'), { folder: document.getElementById('drvFolder').value.trim(), by: googleEmail }, { merge: true });
      const meta = await api(`files/${id}`, { fields: 'id,name,mimeType' }).catch(() => null);
      if (!meta) {
        out.innerHTML = `<p class="warn">The Google account <b>${esc(googleEmail)}</b> can't open this folder. Sign in with the account that owns it
          (or share the folder with ${esc(googleEmail)}).</p><div class="btns"><button class="primary" data-act="driveSwitch">Use a different Google account</button></div>`;
        return;
      }
      const top = await children(id);
      const cands = [];
      for (const f of top.filter(k => k.mimeType === FOLDER).sort((a, b) => a.name.localeCompare(b.name))) {
        if (SKIP_FOLDER.test(f.name)) { cands.push({ name: f.name, skip: 'Card details — never imported' }); continue; }
        if (CONTAINER.test(f.name.trim())) {
          for (const sub of (await children(f.id)).filter(k => k.mimeType === FOLDER)) cands.push({ name: sub.name, id: sub.id, parent: f.name });
        } else cands.push({ name: f.name, id: f.id });
      }
      const looseFiles = top.filter(k => k.mimeType !== FOLDER && !SKIP_FILE.test(k.name) && READABLE(k));
      if (looseFiles.length) cands.push({ name: '(files directly in this folder)', id, loose: true });
      out.innerHTML = '<p class="muted">Counting documents…</p>';
      for (const c of cands.filter(c => c.id)) {
        c.files = c.loose ? looseFiles.map(f => ({ ...f, path: f.name })) : await walk(c.id);
        c.readable = c.files.filter(READABLE);
        out.innerHTML = `<p class="muted">Counting documents… ${esc(c.name)}</p>`;
      }
      plan = cands;
      out.innerHTML = `<hr><p>Signed in to Drive as <b>${esc(googleEmail)}</b> · folder <b>${esc(meta.name)}</b>
          <button class="sm" data-act="driveSwitch">Use a different Google account</button></p>
        <p><b>${cands.filter(c => c.id).length}</b> client folder(s) found. Untick any that are not clients.</p>
        <div class="genlist">${cands.map((c, i) => c.skip
          ? `<div class="small muted">✕ ${esc(c.name)} — ${esc(c.skip)}</div>`
          : `<label class="chk"><input type="checkbox" id="drv_${i}" ${c.readable.length ? 'checked' : ''}> <b>${esc(c.name)}</b>
             ${c.parent ? `<span class="muted tiny">in ${esc(c.parent)}</span>` : ''} <span class="muted tiny">${c.readable.length} PDF/image of ${c.files.length} file(s)</span></label>`).join('')}</div>
        <label class="chk"><input type="checkbox" id="drvCopy" checked> Copy KYC documents into CA Desk (so clients can download them)</label>
        <label class="chk"><input type="checkbox" id="drvDeep"> Thorough mode — also scan files whose names don't look like KYC documents (slower)</label>
        <div class="btns"><button class="primary" data-act="driveRun">Import selected</button></div>
        <div id="drvLog" class="log"></div>`;
    } catch (e) {
      console.error(e);
      out.innerHTML = `<p class="warn">${esc(e.message || String(e))}</p>`;
    }
  };

  A.driveStop = () => { stop = true; };
  A.driveSwitch = () => { token = null; googleEmail = ''; A.driveScan(); };

  A.driveRun = async () => {
    const chosen = plan.filter((c, i) => !c.skip && document.getElementById('drv_' + i)?.checked);
    if (!chosen.length) return toast('Tick at least one folder.');
    const copy = document.getElementById('drvCopy').checked, deep = document.getElementById('drvDeep').checked;
    const logEl = document.getElementById('drvLog');
    const log = (h, cls = '') => { logEl.insertAdjacentHTML('afterbegin', `<div class="small ${cls}">${h}</div>`); };
    document.querySelector('[data-act=driveRun]').outerHTML = '<button data-act="driveStop">Stop after this folder</button>';
    stop = false;
    const totals = { created: 0, updated: 0, docs: 0, read: 0, review: [] };
    await loadClients();
    for (const [n, c] of chosen.entries()) {
      if (stop) { log('Stopped.', 'warn'); break; }
      log(`<b>${n + 1}/${chosen.length} ${esc(c.name)}</b> — reading ${c.readable.length} file(s)…`);
      try { await importFolder(c, { copy, deep, log, totals }); }
      catch (e) { console.error(e); log(`✕ ${esc(c.name)}: ${esc(e.message)}`, 'red'); if (/expired|not enabled/.test(e.message)) break; }
    }
    await loadClients(); render();
    // render() replaces the page; show the summary in a fresh modal
    modal(`<h2>Drive import finished</h2>
      <div class="stats"><div class="stat"><b>${totals.created}</b><span>Clients created</span></div>
        <div class="stat"><b>${totals.updated}</b><span>Clients updated</span></div>
        <div class="stat"><b>${totals.read}</b><span>Documents read</span></div>
        <div class="stat"><b>${totals.docs}</b><span>Documents copied</span></div></div>
      ${totals.review.length ? `<h3>Check these</h3><ul class="small">${totals.review.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : '<p class="ok">No problems found.</p>'}
      <p class="muted small">Imported clients are marked “Imported from Drive” in their notes. Open each one to check the master data, set GST filing type and the TDS / audit ticks.</p>
      <div class="btns"><button class="primary" data-act="go" data-v="clients">View clients</button><button data-act="closeModal">Close</button></div>`);
  };

  /* ---------- per-folder import ---------- */
  async function importFolder(c, { copy, deep, log, totals }) {
    const files = c.readable.filter(f => (+f.size || 0) <= 15e6)
      .sort((a, b) => (KYC_NAME.test(b.name) - KYC_NAME.test(a.name)) || ((+a.size || 0) - (+b.size || 0)));
    const results = [];
    for (const f of files.slice(0, deep ? 60 : 30)) {
      const likely = KYC_NAME.test(f.name);
      const isPdf = /pdf$/i.test(f.mimeType);
      if (!likely && !deep && !isPdf) continue;          // unnamed photos: only in thorough mode
      try {
        const blob = await api(`files/${f.id}`, { alt: 'media' }, true);
        const file = new File([blob], f.name, { type: f.mimeType });
        const text = await extractText(file, () => {}, { maxOcrPages: likely || deep ? 2 : 0, maxTextPages: 6 });
        const res = parse(text);
        totals.read++;
        if (res.type === 'Other' && !res.fields.pan && !res.fields.gstin) continue;
        results.push({ f, file, ...res });
      } catch (e) { log(`  · could not read ${esc(f.name)} (${esc(e.message)})`, 'muted'); }
    }
    if (!results.length) { totals.review.push(`${c.name}: no GST / PAN / incorporation document could be read — add details by hand.`); return; }

    // Who is the client?  An entity document (GST cert, COI, TAN, deed, non-individual PAN) decides it.
    // Otherwise, in a person's folder the PAN whose name matches the folder name is the client;
    // in a generic folder (e.g. "PAN AND AADHAAR") every PAN becomes its own client.
    const entityPan = results.find(r => ENTITY_TYPES.has(r.type) && r.fields.pan)?.fields.pan
      || results.find(r => r.fields.pan && r.fields.pan[3] !== 'P')?.fields.pan;
    const pans = [...new Set(results.map(r => r.fields.pan).filter(Boolean))];
    const toks = s => String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !/^(SIR|THE|AND|PVT|LTD|INDIA)$/.test(w));
    const ft = new Set(toks(c.name));
    const nameHit = r => toks(r.fields.name).some(w => ft.has(w));
    if (entityPan) return saveClient(c, 'main', results, entityPan, { copy, log, totals });
    const owner = results.find(r => r.fields.pan && nameHit(r))?.fields.pan;
    if (owner || pans.length <= 1) return saveClient(c, 'main', results, owner || pans[0] || '', { copy, log, totals });
    for (const pan of pans) {
      const own = results.filter(r => r.fields.pan === pan);
      const nm = toks(own[0].fields.name);
      const aad = results.filter(r => !r.fields.pan && toks(r.fields.name).some(w => nm.includes(w)));
      await saveClient({ ...c, name: own[0].fields.name || c.name }, pan, [...own, ...aad], pan, { copy, log, totals });
    }
    const orphans = results.filter(r => !r.fields.pan && !pans.some(p => toks(results.find(x => x.fields.pan === p).fields.name).some(w => toks(r.fields.name).includes(w))));
    if (orphans.length) totals.review.push(`${c.name}: ${orphans.length} document(s) without a PAN were not matched to anyone (${orphans.map(o => o.f.name).slice(0, 3).join(', ')}).`);
  }

  async function saveClient(c, key, rs, mainPan, { copy, log, totals }) {
    rs.sort((a, b) => (RANK[b.type] ?? -1) - (RANK[a.type] ?? -1));
    const f = {}; let regs = [];
    const people = [];
    for (const r of rs) {
      const x = r.fields;
      const isOther = x.pan && mainPan && x.pan !== mainPan && !x.gstin;   // someone else's PAN/Aadhaar → partner/director
      if (isOther) { if (x.name) people.push(x.name); continue; }
      for (const k of ['name', 'tradeName', 'constitution', 'pan', 'tan', 'cin', 'doi', 'address', 'state', 'pincode', 'email', 'mobile', 'aadhaar', 'people'])
        if (x[k] && !f[k]) f[k] = x[k];
      if (x.gstin && GSTIN_RE.test(x.gstin)) regs = mergeReg(regs, Object.fromEntries(Object.entries({ gstin: x.gstin, state: x.state || stateOf(x.gstin),
        tradeName: x.tradeName, address: x.address, regDate: x.gstRegDate, gstFreq: x.gstFreq || 'Monthly' }).filter(([, v]) => v)));
      if (r.type === 'TAN Allotment' && x.pan && !f.pan) f.pan = x.pan;
    }
    const isEntity = (f.pan || mainPan || '')[3] && (f.pan || mainPan)[3] !== 'P';
    if (people.length && isEntity) {
      const have = (f.people || '').toUpperCase();
      const extra = [...new Set(people)].filter(p => !have.includes(p.toUpperCase()));
      f.people = [f.people, ...extra].filter(Boolean).join('\n');
    }
    if (!regs.length && (f.pan || mainPan || '')[3] === 'P' && (!f.constitution || f.constitution === 'Proprietorship')) f.constitution = 'Individual';
    if (!f.name) f.name = key === 'main' ? c.name.replace(/\s*@.*$/, '').trim() : (rs[0].fields.name || c.name);
    if (!f.pan && mainPan) f.pan = mainPan;

    // match an existing client by PAN or any GSTIN
    const gst = regs.map(r => r.gstin);
    const ex = S.clients.find(x => (f.pan && x.pan === f.pan) || gst.some(g => (x.gstins || []).includes(g) || x.gstin === g));
    let cid;
    if (ex) {
      cid = ex.id;
      const upd = {};
      for (const [k, v] of Object.entries(f)) if (v && !ex[k]) upd[k] = v;          // fill blanks only, never overwrite your edits
      let er = regsOf(ex).map(r => ({ ...r }));
      for (const r of regs) er = er.some(x => x.gstin === r.gstin) ? er : mergeReg(er, r);
      await updateDoc(doc(db, 'clients', cid), { ...upd, ...regMirror(er), updatedAt: serverTimestamp() });
      totals.updated++; log(`  ✓ updated <b>${esc(ex.name)}</b>${regs.length ? ` · ${regs.length} GSTIN(s)` : ''}`);
    } else {
      const data = { ...f, ...regMirror(regs.map(r => ({ id: newRegId(), status: 'Active', ...r }))), portalUsers: [],
        notes: `Imported from Drive folder "${c.parent ? c.parent + ' / ' : ''}${c.name}"`, driveFolder: c.id || '',
        createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
      cid = (await addDoc(collection(db, 'clients'), data)).id;
      S.clients.push({ id: cid, ...data });
      totals.created++; log(`  ✓ created <b>${esc(f.name)}</b>${f.pan ? ` · PAN ${esc(f.pan)}` : ''}${regs.length ? ` · ${regs.length} GSTIN(s)` : ''}`);
    }
    if (!f.pan) totals.review.push(`${f.name}: PAN not found in the documents.`);
    if (!regs.length && /propriet|firm|llp|ltd|company/i.test(f.constitution || '')) totals.review.push(`${f.name}: no GST certificate found — add GSTIN if registered.`);

    if (copy) {
      const cur = (await getDoc(doc(db, 'clients', cid))).data() || {};
      const have = new Set(cur.driveFiles || []);
      const added = [];
      for (const r of rs) {
        if (have.has(r.f.id) || r.type === 'Other' || (+r.f.size || 0) > 8e6) continue;
        try { await saveFile(cid, r.file, r.type); added.push(r.f.id); totals.docs++; }
        catch (e) { log(`  · not copied ${esc(r.f.name)}: ${esc(e.message)}`, 'muted'); }
      }
      if (added.length) await updateDoc(doc(db, 'clients', cid), { driveFiles: [...have, ...added] });
    }
  }

  return {};
}
