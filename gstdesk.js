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
  const { S, A, C, esc, toast, guard, render, regsOf, dispName, isoToDisp, db, fs } = ctx;
  const { getDocs, collectionGroup } = fs;
  const G = {};
  const ver = () => document.documentElement.getAttribute('data-gstdesk-extension') || '';
  const canWrite = () => 'showDirectoryPicker' in window;

  /* ---------- talking to the extension ---------- */
  let seq = 0;
  const waiting = new Map();
  window.addEventListener('message', e => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.gstdesk !== 'ext') return;
    if (e.data.event) { if (e.data.event === 'changed' || e.data.event === 'ready') { S.gdSum = null; if (S.view === 'gstdesk') G.refresh(); } return; }
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
      snap.forEach(d => { const x = d.data(); if (x.portal !== 'gst') return; (by[d.ref.parent.parent.id] ||= []).push(x); });
    } catch { /* no logins yet */ }
    return by;
  }
  const rowsFor = (c, creds) => {
    const regs = regsOf(c).filter(r => r.gstin && r.status !== 'Cancelled');
    const list = creds[c.id] || [];
    return regs.map(r => {
      const cr = list.find(x => x.gstin === r.gstin) || (regs.length === 1 ? list.find(x => !x.gstin) || list[0] : list.find(x => !x.gstin && list.length === 1));
      return { cid: c.id, name: regs.length > 1 ? `${dispName(c)} (${r.state || r.gstin.slice(0, 2)})` : dispName(c), legalName: c.name || '', tradeName: r.tradeName || c.tradeName || '',
        constitution: c.constitution || '', gstin: r.gstin, state: r.state || '', email: c.email || '', mobile: c.mobile || '', tallyCompany: c.tallyCompany || '',
        username: cr?.username || '', password: cr?.password || '' };
    });
  };
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
    if (ver()) { try { S.gdSum = await ask('summary', {}, 6000); } catch { S.gdSum = { error: true }; } }
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
  G.view = () => {
    if (!S.gdLoaded) { G.refresh(); return '<section class="card"><p class="muted">Checking GST Desk…</p></section>'; }
    const v = ver(), l = S.gdLatest, upd = v && l && newer(l.version, v), sum = S.gdSum && !S.gdSum.error ? S.gdSum : null;
    const inGd = new Set((sum?.clients || []).map(x => x.gstin));
    const tag = !v ? '<span class="tag">Not installed in this Chrome</span>' : upd ? `<span class="tag amber">Update available · v${esc(l.version)} (you have v${esc(v)})</span>` : `<span class="tag green">Installed · v${esc(v)}</span>`;
    const done = S.gdSetupDone;
    const steps = `<ol class="ext-steps small">
      <li>${done ? `Files saved in <b>${done.parent ? esc(done.parent) + '\\' : ''}${esc(done.folder)}</b>.` : 'Click <b>Set up GST Desk</b> and choose a folder you will keep, e.g. <b>Documents</b>. CA Desk creates a <b>GST Desk</b> folder in it.'}</li>
      <li>In Chrome open <b>chrome://extensions</b> <button class="sm" data-act="gdCopy" data-t="chrome://extensions">Copy</button> and turn on <b>Developer mode</b> (top right).</li>
      <li>Click <b>Load unpacked</b> and choose that <b>GST Desk</b> folder.</li>
      <li>Reload this page (Ctrl + F5). From then on CA Desk keeps GST Desk updated.</li></ol>`;
    // clients
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
        ${!v ? `<button class="primary" data-act="gdSetup">Set up GST Desk</button><a class="btn" href="${GD_BASE}docs/gst-desk.zip" download>Download zip instead</a>` : ''}
        ${upd ? `<button class="primary" data-act="gdUpdate">Update GST Desk now</button>` : ''}
        ${v ? `<a href="#" class="small" data-act="gdUpdate" data-pick="1">${S.gdLinked ? 'Change GST Desk folder' : 'Link GST Desk folder for one-click updates'}</a>` : ''}
      </div>
      ${!v ? steps : !S.gdLinked ? '<p class="muted small mt">Link the GST Desk folder once (the folder you chose in chrome://extensions) and CA Desk will update GST Desk for you. Choose “Allow on every visit” and updates happen on their own.</p>' : ''}
      <div class="gd-feats">${FEATURES.map(([h, t]) => `<div><b>${esc(h)}</b><span>${esc(t)}</span></div>`).join('')}</div>
    </section>
    ${v ? `<section class="card">
      <div class="row-between wrap"><h2 style="margin:0">Send clients to GST Desk</h2>
        <div class="btns"><input id="gdQ" placeholder="Search client, PAN, GSTIN" value="${esc(S.gdQ || '')}" autocomplete="off">
          <button data-act="gdPick" data-w="new">Select not in GST Desk</button>
          <button class="primary" data-act="gdSend" ${sel.size ? '' : 'disabled'}>Send ${sel.size || ''} to GST Desk</button></div></div>
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
