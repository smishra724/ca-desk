// GST Desk inside CA Desk: set up / update the GST Desk Chrome extension, send clients (GSTIN + GST login) to it,
// open it on a client, and show what it is doing (clients, download queue, recent files).
// GST Desk lives at smishra724.github.io/gst-desk; its extension talks to this page through window.postMessage.

const GD_BASE = 'https://smishra724.github.io/gst-desk/';
const IDB = 'cadesk-gstdesk', STORE = 'h', KEY = 'folder';
const idb = () => new Promise((ok, bad) => { const r = indexedDB.open(IDB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
const idbGet = async () => { try { const d = await idb(); return await new Promise(ok => { const q = d.transaction(STORE).objectStore(STORE).get(KEY); q.onsuccess = () => ok(q.result || null); q.onerror = () => ok(null); }); } catch { return null; } };
const idbSet = async v => { try { const d = await idb(); await new Promise(ok => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(v, KEY); t.oncomplete = ok; t.onerror = ok; }); } catch { /* private mode */ } };
const newer = (a, b) => { const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };

export function initGstDesk(ctx) {
  const { S, A, C, esc, toast, guard, render, regsOf, dispName, isoToDisp, db, fs, isAdmin, loadClients, newRegId, stateOf } = ctx;
  const { getDocs, collectionGroup, collection, doc, addDoc, setDoc, updateDoc, serverTimestamp } = fs;
  const ms = (t) => (t && (typeof t.toMillis === 'function' ? t.toMillis() : t.__ts || (t.seconds ? t.seconds * 1000 : Date.parse(t)))) || 0;
  const G = {};
  const ver = () => document.documentElement.getAttribute('data-gstdesk-extension') || '';
  const canWrite = () => 'showDirectoryPicker' in window;

  /* ---------- talking to the extension ---------- */
  let seq = 0, pullT = null;
  const waiting = new Map();
  window.addEventListener('message', e => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.gstdesk !== 'ext') return;
    if (e.data.event) {
      if (e.data.event === 'changed' || e.data.event === 'ready') {
        S.gdSum = null; if (S.view === 'gstdesk') G.refresh();
        clearTimeout(pullT); pullT = setTimeout(() => G.pull({ quiet: true }).catch(() => {}), 2500);   // GST Desk changed something → bring it into the masters
      }
      return;
    }
    const w = waiting.get(e.data.id); if (!w) return;
    waiting.delete(e.data.id); clearTimeout(w.t);
    if (e.data.stale) { S.gdStale = true; if (S.view === 'gstdesk') render(); }
    e.data.ok ? w.ok(e.data.data) : w.bad(new Error(e.data.error || 'GST Desk did not do that'));
  });
  const ask = (action, extra = {}, ms = 15000) => new Promise((ok, bad) => {
    if (!ver()) return bad(new Error('GST Desk is not installed in this Chrome. Set it up from the GST Desk page.'));
    const id = 'gd' + (++seq);
    waiting.set(id, { ok, bad, t: setTimeout(() => { waiting.delete(id); S.gdStale = true; if (S.view === 'gstdesk') render(); bad(new Error('GST Desk did not answer – it was probably just updated. Reload this page (F5) once and try again.')); }, ms) });
    window.postMessage({ gstdesk: 'page', id, action, ...extra }, location.origin);
  });
  G.installed = ver;
  // Newer GST Desk lets this page open it with a plain link (works even right after GST Desk was updated)
  const extId = () => document.documentElement.getAttribute('data-gstdesk-id') || '';
  const openTab = (hash) => {
    const id = extId();
    if (id) { const w = window.open(`chrome-extension://${id}/manager.html${hash}`, '_blank'); if (w) return Promise.resolve(); }
    return ask('open', { hash }, 6000);
  };
  G.open = (hash = '#clients') => openTab(hash).catch(e => toast(e.message, 8000));

  /* ---------- latest version + one-click install / update ---------- */
  async function latest() {
    if (S.gdLatest) return S.gdLatest;
    try { S.gdLatest = await (await fetch(GD_BASE + 'docs/version.json', { cache: 'no-store' })).json(); } catch { S.gdLatest = null; }
    return S.gdLatest;
  }
  async function gdFolder(dir) {
    const isGd = async d => { try { const m = JSON.parse(await (await (await d.getFileHandle('manifest.json')).getFile()).text()); return /^GST Desk/i.test(m.name || ''); } catch { return false; } };
    if (await isGd(dir)) return dir;
    for await (const [, h] of dir.entries()) if (h.kind === 'directory' && await isGd(h)) return h;
    return null;
  }
  async function perm(h, askUser) {
    if (!h) return 'none';
    if (typeof h.queryPermission !== 'function') return 'granted';
    let p = await h.queryPermission({ mode: 'readwrite' });
    if (p !== 'granted' && askUser) p = await h.requestPermission({ mode: 'readwrite' });
    return p;
  }
  async function writeFiles(h, onStep) {
    onStep('Downloading GST Desk…');
    const list = await (await fetch(GD_BASE + 'extension/files.json', { cache: 'reload' })).json();
    let n = 0;
    for (const f of list.files) {
      const parts = f.split('/');
      let dir = h;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const body = await (await fetch(GD_BASE + 'extension/' + f, { cache: 'reload' })).arrayBuffer();
      const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
      await w.write(body); await w.close();
      if (++n % 8 === 0) onStep(`Writing files… ${n}/${list.files.length}`);
    }
    return list.version;
  }
  // First time: make a "GST Desk" folder wherever you choose and put the extension in it.
  G.setup = () => guard(async () => {
    if (!canWrite()) throw new Error('Use Chrome or Edge on a computer to set up GST Desk.');
    const parent = await window.showDirectoryPicker({ id: 'gstdesk-parent', mode: 'readwrite', startIn: 'documents' });
    let h = await gdFolder(parent);
    if (!h) h = await parent.getDirectoryHandle('GST Desk', { create: true });
    const v = await writeFiles(h, m => toast(m));
    await idbSet(h); S.gdLinked = true;
    S.gdSetupDone = { v, folder: h.name, parent: parent.name };
    render();
  }, 'GST Desk files saved');
  // Update: write the new files into the linked folder and restart the extension.
  G.update = ({ pick } = {}) => guard(async () => {
    if (!canWrite()) throw new Error('Use Chrome or Edge on a computer to update GST Desk.');
    let h = pick ? null : await idbGet();
    if (!h) {
      const d = await window.showDirectoryPicker({ id: 'gstdesk-folder', mode: 'readwrite', startIn: 'documents' });
      h = await gdFolder(d);
      if (!h) throw new Error('That folder does not contain GST Desk. Choose the folder you picked in chrome://extensions → Load unpacked (it has manifest.json inside).');
      await idbSet(h); S.gdLinked = true;
    }
    if (await perm(h, true) !== 'granted') throw new Error('Chrome did not allow CA Desk to update the GST Desk folder. Click Update again and choose “Allow on every visit”.');
    const v = await writeFiles(h, m => toast(m));
    if (ver()) { try { await ask('reload', {}, 4000); } catch { /* older GST Desk – reload it in chrome://extensions */ } }
    toast(`GST Desk updated to v${v}. Reloading…`, 4000);
    setTimeout(() => location.reload(), 2500);
  }, '');
  // Quietly keep GST Desk current when its folder is linked with "Allow on every visit".
  G.autoUpdate = async () => {
    try {
      const v = ver(); if (!v || !canWrite()) return;
      const l = await latest(); if (!l || !newer(l.version, v)) return;
      const h = await idbGet(); if (!h || await perm(h, false) !== 'granted') return;
      await writeFiles(h, () => {});
      try { await ask('reload', {}, 4000); } catch { /* ignore */ }
      toast(`GST Desk updated to v${l.version}`, 5000);
      setTimeout(() => { S.gdSum = null; if (S.view === 'gstdesk') G.refresh(); }, 2500);
    } catch { /* try again next time */ }
  };

  /* ---------- sending clients ---------- */
  async function gstCreds() {
    const by = {};
    try {
      const snap = await getDocs(collectionGroup(db, 'credentials'));
      snap.forEach(d => { const x = d.data(); if (x.portal !== 'gst') return; (by[d.ref.parent.parent.id] ||= []).push({ ...x, _id: d.id }); });
    } catch { /* no logins yet */ }
    return by;
  }
  const rowsFor = (c, creds) => {
    const regs = regsOf(c).filter(r => r.gstin && r.status !== 'Cancelled');
    const list = creds[c.id] || [];
    return regs.map(r => {
      const cr = credFor(list, r.gstin, regs.length);
      return { cid: c.id, name: regs.length > 1 ? `${dispName(c)} (${r.state || r.gstin.slice(0, 2)})` : dispName(c), legalName: c.name || '', tradeName: r.tradeName || c.tradeName || '',
        constitution: c.constitution || '', gstin: r.gstin, state: r.state || '', email: c.email || '', mobile: c.mobile || '', tallyCompany: c.tallyCompany || '',
        username: cr?.username || '', password: cr?.password || '', credAt: ms(cr?.updatedAt) };
    });
  };
  const credFor = (list, gstin, nRegs) => list.find(x => x.gstin === gstin) || (nRegs === 1 ? list.find(x => !x.gstin) || list[0] : list.find(x => !x.gstin && list.length === 1));
  const clientOfGstin = (g) => S.clients.find(c => regsOf(c).some(r => r.gstin === g));

  /* ---------- keeping CA Desk masters and GST Desk clients in step ----------
     CA Desk → GST Desk: every client with an active GSTIN (names, GSTIN, GST login, Tally company); blanks filled, a login saved later wins.
     GST Desk → CA Desk: a GST login changed in GST Desk (typed there or on the GST portal) and the Tally company it was linked to.
     Clients that exist only in GST Desk are listed on the GST Desk page to add to Masters or link. */
  G.pull = async ({ quiet = false } = {}) => {
    if (!ver() || !isAdmin()) return { saved: 0 };
    const r = await ask('export-clients', {}, 15000);
    const creds = await gstCreds();
    let saved = 0;
    const only = [];
    for (const x of r.clients || []) {
      if (!x.gstin) continue;
      const c = clientOfGstin(x.gstin);
      if (!c) { only.push(x); continue; }
      const nRegs = regsOf(c).filter(g => g.gstin && g.status !== 'Cancelled').length || 1;
      const cr = credFor(creds[c.id] || [], x.gstin, nRegs);
      const gdAt = Date.parse(x.changedAt || '') || 0;
      const differs = (x.username && x.username !== (cr?.username || '')) || (x.password && x.password !== (cr?.password || ''));
      if (differs && gdAt > ms(cr?.updatedAt) + 1000) {
        const data = { username: x.username || cr?.username || '', ...(x.password ? { password: x.password } : {}), updatedAt: serverTimestamp(), updatedBy: 'GST Desk' };
        if (cr) await setDoc(doc(db, 'clients', c.id, 'credentials', cr._id), data, { merge: true });
        else await addDoc(collection(db, 'clients', c.id, 'credentials'), { portal: 'gst', label: nRegs > 1 ? `GST ${stateOf(x.gstin)}` : 'GST portal', url: '', notes: 'Saved from GST Desk', gstin: nRegs > 1 ? x.gstin : '', ...data });
        saved++;
      }
      if (x.tallyCompany && !c.tallyCompany) { await updateDoc(doc(db, 'clients', c.id), { tallyCompany: x.tallyCompany }); c.tallyCompany = x.tallyCompany; }
    }
    S.gdOnly = only;
    if (saved) { S.gdCreds = null; if (!quiet) toast(`${saved} GST login${saved > 1 ? 's' : ''} updated from GST Desk`); }
    if (S.view === 'gstdesk') render();
    return { saved, only: only.length };
  };
  G.push = async (cids) => {
    if (!ver() || !isAdmin()) return null;
    const creds = await gstCreds();
    const clients = S.clients.filter(c => !c.exClient && (!cids || cids.includes(c.id))).flatMap(c => rowsFor(c, creds));
    return clients.length ? ask('sync-clients', { clients }, 60000) : null;
  };
  let syncing = null;
  G.sync = ({ quiet = true } = {}) => syncing || (syncing = (async () => {
    try { await G.pull({ quiet }); const r = await G.push(); S.gdSyncAt = Date.now(); S.gdSum = null; if (!quiet && r) toast(`In step with GST Desk · ${r.added} added, ${r.updated} updated`); return r; }
    catch (e) { if (!quiet) toast(e.message, 6000); return null; }
    finally { syncing = null; }
  })());
  // after a client is saved in CA Desk
  G.pushSoon = (cid) => { if (ver() && cid) setTimeout(() => G.push([cid]).catch(() => {}), 300); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ver() && Date.now() - (S.gdSyncAt || 0) > 120000) G.sync(); });

  // Client that is only in GST Desk → new master (with its GSTIN and GST login), or link it to an existing master
  const CONS_MAP = [[/llp/i, 'LLP'], [/public/i, 'Public Ltd'], [/private|pvt/i, 'Private Ltd'], [/partner/i, 'Partnership Firm'], [/propriet/i, 'Proprietorship']];
  G.addMaster = (gstin) => guard(async () => {
    const x = (S.gdOnly || []).find(y => y.gstin === gstin); if (!x) return;
    const reg = { id: newRegId(), gstin, state: stateOf(gstin), tradeName: x.tradeName || '', gstFreq: 'Monthly', status: 'Active' };
    const cons = (CONS_MAP.find(([rx]) => rx.test(x.constitution || '')) || [])[1] || '';
    const cid = (await addDoc(collection(db, 'clients'), { name: (x.legalName || x.name || '').toUpperCase(), tradeName: x.tradeName || '', pan: x.pan || gstin.slice(2, 12), constitution: cons,
      email: x.email || '', mobile: x.mobile || '', tallyCompany: x.tallyCompany || '', gstRegs: [reg], gstins: [gstin], gstin, portalUsers: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp() })).id;
    if (x.username) await addDoc(collection(db, 'clients', cid, 'credentials'), { portal: 'gst', label: 'GST portal', url: '', notes: 'Saved from GST Desk', gstin: '', username: x.username, password: x.password || '', updatedAt: serverTimestamp(), updatedBy: 'GST Desk' });
    await loadClients();
    await G.push([cid]);
    S.gdOnly = S.gdOnly.filter(y => y.gstin !== gstin); S.gdCreds = null;
    render();
  }, 'Added to Masters and linked');
  G.linkMaster = (gstin, cid) => guard(async () => {
    const x = (S.gdOnly || []).find(y => y.gstin === gstin); const c = S.clients.find(y => y.id === cid);
    if (!x || !c) throw new Error('Choose the client to link to');
    const regs = regsOf(c).slice();
    if (!regs.some(r => r.gstin === gstin)) regs.push({ id: newRegId(), gstin, state: stateOf(gstin), tradeName: x.tradeName || '', gstFreq: 'Monthly', status: 'Active' });
    const act = regs.filter(r => r.gstin && r.status !== 'Cancelled');
    await updateDoc(doc(db, 'clients', cid), { gstRegs: regs, gstins: regs.map(r => r.gstin).filter(Boolean), gstin: (act[0] || regs[0]).gstin, ...(x.tallyCompany && !c.tallyCompany ? { tallyCompany: x.tallyCompany } : {}), updatedAt: serverTimestamp() });
    if (x.username && !(await gstCreds())[cid]?.some(k => k.gstin === gstin || !k.gstin)) await addDoc(collection(db, 'clients', cid, 'credentials'), { portal: 'gst', label: `GST ${stateOf(gstin)}`, url: '', notes: 'Saved from GST Desk', gstin, username: x.username, password: x.password || '', updatedAt: serverTimestamp(), updatedBy: 'GST Desk' });
    await loadClients();
    await G.push([cid]);
    S.gdOnly = S.gdOnly.filter(y => y.gstin !== gstin); S.gdCreds = null;
    render();
  }, 'Linked – the GSTIN is now on that master');
  G.send = async (cids, { replacePasswords = false, quiet = false } = {}) => {
    const creds = await gstCreds();
    const clients = S.clients.filter(c => cids.includes(c.id)).flatMap(c => rowsFor(c, creds));
    if (!clients.length) throw new Error('No active GSTIN on the chosen client(s).');
    const r = await ask('sync-clients', { clients, replacePasswords }, 30000);
    S.gdSum = null;
    if (!quiet) toast(!r.added && !r.updated && !r.passwords ? 'GST Desk already has these clients – nothing new to add' : `Sent to GST Desk: ${r.added} new, ${r.updated} updated${r.passwords ? `, ${r.passwords} password${r.passwords > 1 ? 's' : ''} saved` : ''}${r.locked ? ` · ${r.locked} password(s) not saved – open GST Desk and unlock passwords (tick Remember)` : ''}`, 7000);
    return r;
  };
  // From a client's page: send it, then open GST Desk on that GSTIN
  G.openClient = (cid, gstin) => guard(async () => {
    await G.send([cid], { quiet: true });
    await openTab('#gstin=' + encodeURIComponent(gstin || ''));
  }, '');

  /* ---------- page ---------- */
  G.refresh = async () => {
    const [l, h] = await Promise.all([latest(), idbGet()]);
    S.gdLinked = !!h;
    if (ver()) { try { S.gdSum = await ask('summary', {}, 6000); } catch { S.gdSum = { error: true }; } if (!S.gdOnly) await G.pull({ quiet: true }).catch(() => {}); }
    if (!S.gdCreds) { const cr = await gstCreds(); S.gdCreds = {}; for (const [k, v] of Object.entries(cr)) S.gdCreds[k] = v.length; }
    S.gdLoaded = true;
    if (S.view === 'gstdesk') render();
    return l;
  };
  const FEATURES = [
    ['Client master', 'GSTIN, GST ID and password (saved encrypted, typed once), Tally company and full registration details.'],
    ['Import from GST portal', 'Logs in (you type the CAPTCHA), reads the client’s profile and fills names, address, partners/directors, activities, HSN/SAC and jurisdiction.'],
    ['GST registration', 'Fills the new-registration forms on reg.gst.gov.in tab by tab; you type every CAPTCHA/OTP and submit yourself.'],
    ['Bulk return downloads', 'GSTR-1 (PDF/JSON), GSTR-2B (Excel/JSON) and GSTR-3B (PDF) for many clients and months, saved as Downloads/GST Desk/<Client>/<FY>/.'],
    ['Tally & GST work', 'Reads TallyPrime over port 9000: registers, GSTR-1 JSON, 3B working, 2B and GSTR-1 reconciliation in Excel.'],
  ];
  // Settings → "GST Desk extension": install / download / update / link folder
  G.installCard = () => {
    if (S.gdLatest === undefined && !S.gdLatestLoading) { S.gdLatestLoading = true; Promise.all([latest(), idbGet()]).then(([, h]) => { S.gdLinked = !!h; S.gdLatestLoading = false; if (S.view === 'settings') render(); }); }
    const v = ver(), l = S.gdLatest, upd = v && l && newer(l.version, v), done = S.gdSetupDone;
    const tag = !v ? '<span class="tag">Not installed in this Chrome</span>' : upd ? `<span class="tag amber">Update available · v${esc(l.version)} (you have v${esc(v)})</span>` : `<span class="tag green">Installed · v${esc(v)}</span>`;
    return `<div class="row-between wrap"><p class="muted small" style="margin:0">Chrome extension for the GST portal: returns download, import from GST portal, registration filling and Tally GST work. Linked with your Masters.${l ? ` Latest version v${esc(l.version)}.` : ''}</p><div>${tag}</div></div>
      <div class="btns mt">
        ${!v ? `<button class="primary" data-act="gdSetup">Set up GST Desk</button>` : ''}
        ${upd ? `<button class="primary" data-act="gdUpdate">Update GST Desk now</button>` : ''}
        <a class="btn" href="${GD_BASE}docs/gst-desk.zip" download>Download GST Desk (zip)</a>
        ${v ? `<button data-act="gdUpdate" data-pick="1">${S.gdLinked ? 'Change GST Desk folder' : 'Link GST Desk folder for one-click updates'}</button><button data-act="gdOpen" data-h="#clients">Open GST Desk</button>` : ''}
      </div>
      ${!v ? `<ol class="ext-steps small">
        <li>${done ? `Files saved in <b>${done.parent ? esc(done.parent) + '\\' : ''}${esc(done.folder)}</b>.` : 'Click <b>Set up GST Desk</b> and choose a folder you will keep, e.g. <b>Documents</b> – CA Desk creates a <b>GST Desk</b> folder in it. (Or download the zip and unzip it.)'}</li>
        <li>In Chrome open <b>chrome://extensions</b> <button class="sm" data-act="gdCopy" data-t="chrome://extensions">Copy</button> and turn on <b>Developer mode</b> (top right).</li>
        <li>Click <b>Load unpacked</b> and choose that <b>GST Desk</b> folder.</li>
        <li>Reload this page (Ctrl + F5). From then on CA Desk keeps GST Desk updated.</li></ol>`
        : !S.gdLinked ? '<p class="muted small mt">Link the GST Desk folder once (the folder you chose in chrome://extensions) and CA Desk updates GST Desk for you. Choose “Allow on every visit” and updates happen on their own.</p>' : '<p class="muted small mt">GST Desk folder linked – CA Desk keeps it up to date.</p>'}`;
  };

  G.view = () => {
    if (!S.gdLoaded) { G.refresh(); return '<section class="card"><p class="muted">Checking GST Desk…</p></section>'; }
    const v = ver(), l = S.gdLatest, upd = v && l && newer(l.version, v), sum = S.gdSum && !S.gdSum.error ? S.gdSum : null;
    const inGd = new Set((sum?.clients || []).map(x => x.gstin));
    const tag = !v ? '<span class="tag">Not installed in this Chrome</span>' : upd ? `<span class="tag amber">Update available · v${esc(l.version)} (you have v${esc(v)})</span>` : `<span class="tag green">Installed · v${esc(v)}</span>`;
    // clients
    if (!S.gdCreds && !S.gdCredsLoading) { S.gdCredsLoading = true; gstCreds().then(cr => { S.gdCreds = {}; for (const [k, v] of Object.entries(cr)) S.gdCreds[k] = v.length; S.gdCredsLoading = false; if (S.view === 'gstdesk') render(); }); }
    const creds = S.gdCreds || {};
    const q = (S.gdQ || '').toLowerCase();
    const rows = S.clients.filter(c => !c.exClient).flatMap(c => regsOf(c).filter(r => r.gstin && r.status !== 'Cancelled').map(r => ({ c, r })))
      .filter(({ c, r }) => !q || [dispName(c), c.name, c.pan, r.gstin, r.state].some(x => String(x || '').toLowerCase().includes(q)));
    const sel = S.gdSel ||= new Set();
    const queue = sum?.queue;
    const qDone = queue ? queue.items.reduce((n, it) => n + it.jobs.filter(j => j.status === 'done').length, 0) : 0;
    const qAll = queue ? queue.items.reduce((n, it) => n + it.jobs.length, 0) : 0;
    return `
    ${S.gdStale ? '<div class="warn" style="margin-bottom:12px;display:flex;gap:10px;align-items:center;justify-content:space-between"><span>GST Desk was updated or reloaded since this page opened, so the buttons cannot reach it. Reload this page once.</span><button class="primary sm" data-act="gdReload">Reload page</button></div>' : ''}
    <section class="card">
      <div class="row-between wrap"><div><h2 style="margin:0">GST Desk</h2><p class="muted small" style="margin:.2rem 0 0">Chrome extension for the GST portal — works alongside CA Desk.</p></div>
        <div>${tag}</div></div>
      <div class="btns mt">
        ${v ? `<button class="primary" data-act="gdOpen" data-h="#clients">Open GST Desk</button><button data-act="gdOpen" data-h="#downloads">Download returns</button><button data-act="gdOpen" data-h="#work">Tally &amp; GST work</button>` : ''}
      </div>
      ${!v ? '<p class="mt">GST Desk is not installed in this Chrome yet. <button class="primary sm" data-act="gdToSettings">Install it from Settings</button></p>'
        : upd ? `<p class="small mt">A new version (v${esc(l.version)}) is ready. <a href="#" data-act="gdToSettings">Update it in Settings</a></p>` : ''}
      <div class="gd-feats">${FEATURES.map(([h, t]) => `<div><b>${esc(h)}</b><span>${esc(t)}</span></div>`).join('')}</div>
    </section>
    ${v ? `<section class="card">
      <div class="row-between wrap"><h2 style="margin:0">Send clients to GST Desk</h2>
        <div class="btns"><input id="gdQ" placeholder="Search client, PAN, GSTIN" value="${esc(S.gdQ || '')}" autocomplete="off">
          <button data-act="gdPick" data-w="new">Select not in GST Desk</button>
          <button class="primary" data-act="gdSend" ${sel.size ? '' : 'disabled'}>Send ${sel.size || ''} to GST Desk</button></div></div>
      <p class="small" style="margin:.2rem 0 .4rem">🔗 <b>Masters and GST Desk are linked</b> — clients with a GSTIN go to GST Desk automatically, and GST logins changed in GST Desk come back here. ${S.gdSyncAt ? `Last synced ${new Date(S.gdSyncAt).toLocaleTimeString()}.` : ''} <a href="#" data-act="gdSync">Sync now</a></p>
      <p class="muted small">Each GSTIN becomes a GST Desk client with its GST portal user ID and password, so returns download and the portal import work without typing them again. Details already in GST Desk are kept.
        <label class="small" style="display:inline-flex;gap:.3rem;align-items:center;margin-left:.6rem"><input type="checkbox" style="width:auto;margin:0" data-change="gdReplace" ${S.gdReplace ? 'checked' : ''}> Replace GST Desk passwords that differ</label></p>
      <table class="tbl"><thead><tr><th><input type="checkbox" data-change="gdAll" ${rows.length && rows.every(({ c }) => sel.has(c.id)) ? 'checked' : ''} aria-label="Select all"></th><th>Client</th><th>GSTIN</th><th>State</th><th>GST login in CA Desk</th><th>In GST Desk</th><th></th></tr></thead><tbody>
      ${rows.map(({ c, r }) => `<tr><td><input type="checkbox" data-change="gdSel" data-id="${c.id}" ${sel.has(c.id) ? 'checked' : ''}></td>
        <td><b>${esc(dispName(c))}</b><div class="muted tiny">${esc(c.constitution || '')}</div></td><td class="mono nowrap">${esc(r.gstin)}</td><td>${esc(r.state || '')}</td>
        <td>${creds[c.id] ? '<span class="tag green">Saved</span>' : '<span class="muted small">—</span>'}</td>
        <td>${inGd.has(r.gstin) ? '<span class="tag green">✓</span>' : '<span class="muted small">Not yet</span>'}</td>
        <td class="nowrap"><button class="sm" data-act="gdClient" data-id="${c.id}" data-gstin="${esc(r.gstin)}">Open in GST Desk</button></td></tr>`).join('')
        || '<tr><td colspan="7" class="muted empty">No client with an active GSTIN.</td></tr>'}
      </tbody></table>
    </section>
    ${(S.gdOnly || []).length ? `<section class="card">
      <h2>In GST Desk but not in Masters <span class="muted">(${S.gdOnly.length})</span></h2>
      <p class="muted small">Add each one as a new master (with its GSTIN and GST login), or link it to the master it belongs to (the GSTIN is added to that client).</p>
      <table class="tbl"><thead><tr><th>GST Desk client</th><th>GSTIN</th><th>GST ID</th><th>Link to master</th><th></th></tr></thead><tbody>
      ${S.gdOnly.map(x => { const pan = x.gstin.slice(2, 12); const sug = S.clients.filter(c => c.pan === pan); return `<tr><td><b>${esc(x.name)}</b>${x.legalName && x.legalName !== x.name ? `<div class="muted tiny">${esc(x.legalName)}</div>` : ''}</td><td class="mono nowrap">${esc(x.gstin)}</td><td>${esc(x.username || '—')}</td>
        <td><select id="gdl-${esc(x.gstin)}" style="max-width:260px"><option value="">— Choose master —</option>${sug.map(c => `<option value="${c.id}" selected>${esc(dispName(c))} (same PAN)</option>`).join('')}${S.clients.filter(c => !sug.includes(c)).map(c => `<option value="${c.id}">${esc(dispName(c))}</option>`).join('')}</select> <button class="sm" data-act="gdLink" data-g="${esc(x.gstin)}">Link</button></td>
        <td class="nowrap"><button class="sm primary" data-act="gdAddMaster" data-g="${esc(x.gstin)}">Add to Masters</button></td></tr>`; }).join('')}
      </tbody></table></section>` : ''}
    <section class="card">
      <h2>In GST Desk now</h2>
      ${sum ? `<div class="gd-stats"><div><b>${sum.clients.length}</b><span>clients</span></div><div><b>${sum.clients.filter(x => x.passwordSaved).length}</b><span>with GST password</span></div>
        <div><b>${queue ? `${qDone}/${qAll}` : '—'}</b><span>${queue ? `downloads · ${esc(queue.status)}` : 'no download queue'}</span></div></div>
        ${(sum.downloads || []).length ? `<table class="tbl mt"><thead><tr><th>Recent file</th><th>Client</th><th>When</th></tr></thead><tbody>${sum.downloads.slice(0, 8).map(d => `<tr><td class="small">${esc(String(d.filename || d.file || '').split(/[\\/]/).pop())}</td><td>${esc(d.client || d.name || '')}</td><td class="nowrap small">${d.at ? isoToDisp(String(d.at).slice(0, 10)) : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">No downloads yet.</p>'}`
        : '<p class="muted small">GST Desk did not answer. Reload this page (Ctrl + F5).</p>'}
    </section>` : ''}`;
  };

  // GST Desk → "Get it from CA Desk" opens CA Desk at #gstdesk=<Tally company>: show the GST Desk page with that client picked
  G.fromHash = () => {
    const m = /^#gstdesk(?:=(.*))?$/.exec(location.hash || ''); if (!m) return false;
    const q = decodeURIComponent(m[1] || '').trim();
    const key = s => String(s || '').toUpperCase().replace(/\bPRIVATE\b/g, 'PVT').replace(/\bLIMITED\b/g, 'LTD').replace(/[^A-Z0-9]/g, '');
    S.view = 'gstdesk';
    if (q) {
      const hits = S.clients.filter(c => !c.exClient && regsOf(c).some(r => r.gstin && r.status !== 'Cancelled') && [c.name, c.tradeName, dispName(c)].some(n => n && (key(n) === key(q) || key(n).includes(key(q)) || key(q).includes(key(n)))));
      S.gdSel = new Set(hits.map(c => c.id));
      S.gdQ = hits.length ? '' : q.split(/\s+/)[0];
      setTimeout(() => toast(hits.length ? `Found ${hits.map(dispName).join(', ')} – click “Send to GST Desk”` : `No CA Desk client with an active GSTIN matches “${q}”. Search below or add the client in Masters first.`, 8000), 600);
    }
    history.replaceState(null, '', location.pathname);
    return true;
  };

  /* ---------- actions ---------- */
  A.gdOpen = ({ h }) => G.open(h);
  A.gdReload = () => location.reload();
  A.gdToSettings = () => { S.view = 'settings'; render(); setTimeout(() => document.getElementById('gdext')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); };
  A.gdAddMaster = ({ g }) => G.addMaster(g);
  A.gdLink = ({ g }) => G.linkMaster(g, document.getElementById('gdl-' + g)?.value || '');
  A.gdSync = () => G.sync({ quiet: false }).then(() => G.refresh());
  A.gdSetup = () => G.setup();
  A.gdUpdate = ({ pick }) => G.update({ pick: !!pick });
  A.gdCopy = ({ t }) => navigator.clipboard.writeText(t).then(() => toast('Copied — paste it in the Chrome address bar'));
  A.gdClient = ({ id, gstin }) => G.openClient(id, gstin);
  A.gdPick = ({ w }) => { const inGd = new Set((S.gdSum?.clients || []).map(x => x.gstin)); S.gdSel = new Set(S.clients.filter(c => !c.exClient && regsOf(c).some(r => r.gstin && r.status !== 'Cancelled' && (w !== 'new' || !inGd.has(r.gstin)))).map(c => c.id)); render(); };
  A.gdSend = () => guard(async () => { await G.send([...(S.gdSel || [])], { replacePasswords: !!S.gdReplace }); S.gdSel = new Set(); await G.refresh(); }, '');
  C.gdSel = el => { const s = S.gdSel ||= new Set(); el.checked ? s.add(el.dataset.id) : s.delete(el.dataset.id); render(); };
  C.gdAll = el => { S.gdSel = el.checked ? new Set(S.clients.filter(c => !c.exClient && regsOf(c).some(r => r.gstin && r.status !== 'Cancelled')).map(c => c.id)) : new Set(); render(); };
  C.gdReplace = el => { S.gdReplace = el.checked; };
  return G;
}
