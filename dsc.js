// DSC register: every digital signature token the firm handles, mapped to a client — holder, class, validity,
// token PIN, and where the token physically is (in office / with client) with an in/out movement log.
// Stored under clients/{cid}/dsc so each client sees its own DSCs; the register page lists all of them.

const CLASSES = ['Class 3 – Signing', 'Class 3 – Signing & Encryption', 'Class 3 – DGFT', 'Class 3 – Organisation', 'Other'];
const ISSUERS = ['eMudhra', 'Capricorn', 'Vsign (Verasys)', 'Pantasign', 'XtraTrust', 'IDSign', 'Sify', 'NSDL', 'Other'];
const TOKENS = ['ePass 2003', 'ProxKey', 'mToken', 'HyperSecu', 'Trust Key', 'WD ProxKey', 'Other'];
const ROLES = ['Director', 'Partner', 'Designated partner', 'Proprietor', 'Authorised signatory', 'Karta', 'Trustee', 'Individual'];
const CUSTODY = ['In office', 'With client', 'With other CA', 'Lost / not available'];

import { parseCertFile, certToDsc } from './dsccert.js';

export function initDsc(ctx) {
  const { S, A, C, F, esc, toast, modal, closeModal, guard, render, isAdmin, isoToDisp, todayISO, db, fs, saveBlob, WA_ICON, MAIL_ICON } = ctx;
  const { doc, getDocs, setDoc, deleteDoc, collection } = fs;
  const D = {};
  const days = d => d ? Math.round((new Date(d + 'T00:00') - new Date(todayISO() + 'T00:00')) / 864e5) : null;
  const validity = x => { const n = days(x.validTo); return n === null ? ['', 'No expiry date'] : n < 0 ? ['late', `Expired ${-n}d ago`] : n <= 30 ? ['soon', `${n}d left`] : n <= 90 ? ['mid', `${Math.round(n / 30)} months left`] : ['ok', 'Valid']; };
  const cName = cid => (S.clients.find(c => c.id === cid) || S.exClients?.find(c => c.id === cid) || {}).name || '—';
  const waNum = s => { const d = String(s || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d.replace(/^0+/, ''); };

  // all DSCs across clients (one small read per client; loaded in the background after sign-in)
  D.loadAll = async () => {
    const all = [...S.clients, ...(S.exClients || [])];
    const res = await Promise.all(all.map(c => getDocs(collection(db, 'clients', c.id, 'dsc')).then(s => s.docs.map(d => ({ id: d.id, cid: c.id, ...d.data() }))).catch(() => [])));
    S.dsc = res.flat(); return S.dsc;
  };
  D.alerts = () => (S.dsc || []).filter(x => x.status !== 'Inactive' && x.validTo && days(x.validTo) <= 30);

  /* ---------- register page ---------- */
  D.view = () => {
    if (!S.dsc) { D.loadAll().then(render); return '<section class="card"><p class="muted">Loading DSC register…</p></section>'; }
    const f = S.dscF ||= { q: '', show: '', cust: '' };
    const q = f.q.toLowerCase(), act = S.dsc.filter(x => x.status !== 'Inactive');
    let list = S.dsc.filter(x => (!q || [x.holder, x.pan, cName(x.cid), x.serial, x.issuer, x.mobile].some(v => (v || '').toLowerCase().includes(q)))
      && (!f.cust || x.custody === f.cust)
      && (!f.show || (f.show === 'expired' ? days(x.validTo) < 0 : f.show === 'soon' ? days(x.validTo) >= 0 && days(x.validTo) <= 30 : f.show === 'inactive' ? x.status === 'Inactive' : x.status !== 'Inactive')))
      .sort((a, b) => (a.validTo || '9999').localeCompare(b.validTo || '9999'));
    const n = { all: act.length, office: act.filter(x => x.custody === 'In office').length, client: act.filter(x => x.custody === 'With client').length,
      soon: act.filter(x => { const d = days(x.validTo); return d !== null && d >= 0 && d <= 30; }).length, exp: act.filter(x => days(x.validTo) < 0).length };
    const ctr = (k, v, l, cls, on) => `<button class="ctr ${cls} ${on ? 'on' : ''}" data-act="dscF" data-k="${k}" data-v="${v}"><b>${n[{ show: v === 'soon' ? 'soon' : v === 'expired' ? 'exp' : 'all', cust: v === 'In office' ? 'office' : 'client' }[k]]}</b><span>${l}</span></button>`;
    return `<section class="card">
      <div class="row-between wrap"><div><h2>DSC register</h2><p class="muted small">Digital signature tokens held for clients — validity, PIN and where each token is.</p></div>
        <div class="btns"><button data-act="dscExport">Export Excel</button><button class="primary" data-act="dscEdit">+ Add DSC</button></div></div>
      <div class="ctrs dscctr">
        ${ctr('show', '', 'Active DSCs', 'c-all', !f.show && !f.cust)}${ctr('cust', 'In office', 'In office', 'c-cp', f.cust === 'In office')}${ctr('cust', 'With client', 'With client', 'c-wc', f.cust === 'With client')}
        ${ctr('show', 'soon', 'Expiring in 30 days', 'c-today', f.show === 'soon')}${ctr('show', 'expired', 'Expired', 'c-late', f.show === 'expired')}
      </div>
      <div class="filters"><input id="dscQ" placeholder="Search holder, client, PAN, serial no., mobile" value="${esc(f.q)}">
        <select data-change="dscShow"><option value="">Active</option><option value="soon" ${f.show === 'soon' ? 'selected' : ''}>Expiring in 30 days</option><option value="expired" ${f.show === 'expired' ? 'selected' : ''}>Expired</option><option value="inactive" ${f.show === 'inactive' ? 'selected' : ''}>Inactive / surrendered</option></select>
        ${f.q || f.show || f.cust ? '<a href="#" data-act="dscClear" class="small">Clear filters</a>' : ''}</div>
      ${live()}
      ${table(list, true)}
    </section>`;
  };

  /* ---------- plugged-in tokens (CA Desk DSC reader on this computer, through the extension) ---------- */
  const normN = s => String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
  const inReg = c => (S.dsc || []).find(x => (x.certThumb && x.certThumb === c.thumb) || (x.certSerial && x.certSerial === c.serial)) || (S.dsc || []).find(x => normN(x.holder) === normN(c.cn) && (!x.validTo || x.validTo === c.to));
  // client the DSC most likely belongs to: organisation name, a director / partner / proprietor, or the individual client
  function guessClient(c) {
    const n = normN(c.cn), o = normN(c.o);
    const hit = S.clients.find(x => o && o.length > 4 && normN(x.name).startsWith(o.split(' ').slice(0, 2).join(' ')))
      || S.clients.find(x => (x.directors || []).some(d => !d.ceased && normN(d.name) === n))
      || S.clients.find(x => normN(x.people || '').includes(n) || normN(x.proprietor || x.propName || '') === n)
      || S.clients.find(x => normN(x.name) === n);
    return hit || null;
  }
  const ask = () => new Promise(res => {
    const id = 'd' + Date.now() + Math.random().toString(36).slice(2, 6);
    const to = setTimeout(() => { window.removeEventListener('message', on); res({ ok: false, error: 'No answer from the DSC reader' }); }, 20000);
    function on(e) { if (e.source !== window || e.data?.type !== 'CAPM_DSC_RES' || e.data.id !== id) return; clearTimeout(to); window.removeEventListener('message', on); res(e.data); }
    window.addEventListener('message', on); window.postMessage({ type: 'CAPM_DSC', id }, location.origin);
  });
  const extOk = () => { const v = document.documentElement.dataset.capmVer || ''; const [a, b] = v.split('.').map(Number); return a > 1 || (a === 1 && b >= 7); };
  let busyPoll = false;
  async function poll() {
    if (busyPoll || S.view !== 'dsc' || document.hidden || !isAdmin()) return;
    const L = S.dscLive ||= { state: 'check', certs: [], seen: null, fresh: [] };
    if (!extOk()) { if (L.state !== 'noext') { L.state = 'noext'; render(); } return; }
    busyPoll = true;
    try {
      const r = await ask();
      if (!r.ok) { const st = r.missing || /native messaging host|not found|forbidden/i.test(r.error || '') ? 'nohelper' : 'error'; if (L.state !== st) { L.state = st; L.error = r.error; render(); } return; }
      const certs = (r.certs || []).filter(c => c.onToken || /mudhra|capricorn|verasys|vsign|panta|xtra|idsign|sify|safescrypt|nsdl|protean|ca for|sub ca/i.test(`${c.io} ${c.icn}`));
      const thumbs = certs.map(c => c.thumb).sort().join(',');
      const was = L.seen;
      const fresh = was === null ? [] : certs.filter(c => !was.split(',').includes(c.thumb)).map(c => c.thumb);
      if (fresh.length) { const c = certs.find(x => x.thumb === fresh[0]); toast(`DSC detected: ${c.cn} (${certToDsc(c).issuer}, valid till ${isoToDisp(c.to)})`, 7000); }
      const changed = L.state !== 'ok' || thumbs !== was || (r.tokens || []).join() !== (L.tokens || []).join();
      Object.assign(L, { state: 'ok', certs, tokens: r.tokens || [], seen: thumbs, fresh: fresh.length ? fresh : L.fresh });
      if (changed) render();
    } finally { busyPoll = false; }
  }
  setInterval(poll, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  function live() {
    if (!isAdmin()) return '';
    const L = S.dscLive || { state: 'check' };
    setTimeout(poll, 50);
    const fileBtn = '<label class="sm btn-like">Read a certificate file<input type="file" accept=".cer,.crt,.pem,.der" data-change="dscCertFile" hidden></label>';
    if (L.state === 'noext') return `<div class="dsclive off"><div><b>Detect plugged-in DSC tokens</b><p class="small muted">Needs the CA Desk Helper extension version 1.7 — update it from Settings → Browser extension (or the Update button on the Dashboard). Meanwhile you can read a certificate file exported from the token’s software.</p></div>${fileBtn}</div>`;
    if (L.state === 'nohelper' || L.state === 'error') return `<div class="dsclive off"><div><b>Detect plugged-in DSC tokens</b><p class="small">Like the GST and Income Tax portals (emBridge / emSigner), CA Desk needs a small reader on this computer to see the token. Install it once — about 10 seconds, no admin rights:</p>
      <ol class="small"><li><button class="sm primary" data-act="dscHelper">Download DSC reader</button> and double-click <b>CA-Desk-DSC-reader.cmd</b> (if Windows shows “Windows protected your PC”, click <b>More info → Run anyway</b>).</li><li>Come back here — plugged-in tokens appear within a few seconds.</li></ol>
      <p class="tiny muted">The reader only lists the certificates Windows sees on the token (name, issuer, validity). It never asks for the PIN or signs anything.${L.state === 'error' ? ` Last message: ${esc(L.error || '')}` : ''}</p></div>${fileBtn}</div>`;
    if (L.state !== 'ok') return `<div class="dsclive"><span class="muted small">Looking for plugged-in DSC tokens…</span></div>`;
    const rows = (L.certs || []).map(c => { const d = certToDsc(c), reg = inReg(c), cl = reg ? null : guessClient(c), fresh = (L.fresh || []).includes(c.thumb);
      const upd = reg && (reg.validTo !== c.to || !reg.certThumb);
      return `<div class="dscc ${fresh ? 'fresh' : ''}"><div class="dscc-i">🔑</div><div class="dscc-m"><b>${esc(c.cn)}</b>${c.o && d.certOrg ? ` <span class="muted">· ${esc(c.o)}</span>` : ''}
          <div class="small">${esc(d.issuer)} · ${esc(d.cls)} · valid ${isoToDisp(c.from)} – <b>${isoToDisp(c.to)}</b>${c.provider ? ` · ${esc(d.token || c.provider)}` : ''}</div>
          <div class="tiny muted">${reg ? `In register under <b>${esc(cName(reg.cid))}</b>${upd ? ` — register says valid till ${isoToDisp(reg.validTo) || '—'}` : ' — up to date'}` : cl ? `Not in register · looks like <b>${esc(cl.name)}</b>` : 'Not in register'}</div></div>
        <div class="btns">${reg ? (upd ? `<button class="sm primary" data-act="dscLiveUpd" data-t="${c.thumb}">Update register</button>` : `<button class="sm" data-act="dscEdit" data-id="${reg.id}" data-cid="${reg.cid}">Open</button>`) : `<button class="sm primary" data-act="dscLiveAdd" data-t="${c.thumb}">Add to register</button>`}</div></div>`; }).join('');
    return `<div class="dsclive on"><div class="row-between wrap"><b>Plugged-in DSC tokens</b><span class="small muted">${(L.tokens || []).length ? esc(L.tokens.join(', ')) : 'No token connected'} · checks every few seconds ${fileBtn}</span></div>
      ${rows || '<p class="small muted">Plug in a DSC token — it shows up here with holder, issuer and validity. (If a token is plugged in but nothing shows, open its software once so Windows registers the certificate.)</p>'}</div>`;
  }
  A.dscHelper = () => {
    const id = document.documentElement.dataset.capmId; if (!id) return toast('Update the CA Desk Helper extension to version 1.7 first.');
    guard(async () => {
      const t = await (await fetch('dsc-reader-install.tpl', { cache: 'reload' })).text();
      const cmd = t.replace('__EXTID__', id).replace(/\r?\n/g, '\r\n');
      ctx.saveBlob(new Blob([cmd], { type: 'application/octet-stream' }), 'CA-Desk-DSC-reader.cmd');
    });
  };
  const fromCert = c => { const d = certToDsc(c), cl = guessClient(c); S.dscPrefill = { ...d, cid: cl?.id || '', role: d.certOrg ? 'Authorised signatory' : (cl?.directors || []).some(x => normN(x.name) === normN(c.cn)) ? 'Director' : '', notes: c.provider ? `Detected from token (${c.provider})` : 'Read from certificate file' }; A.dscEdit({}); };
  A.dscLiveAdd = ({ t }) => { const c = (S.dscLive?.certs || []).find(x => x.thumb === t); if (c) fromCert(c); };
  A.dscLiveUpd = ({ t }) => {
    const c = (S.dscLive?.certs || []).find(x => x.thumb === t), reg = c && inReg(c); if (!reg) return;
    guard(async () => {
      const d = certToDsc(c), data = { ...reg, validFrom: d.validFrom, validTo: d.validTo, certThumb: d.certThumb, certSerial: d.certSerial, issuer: reg.issuer || d.issuer, token: reg.token || d.token, status: 'Active', updatedAt: new Date().toISOString() };
      const { id, cid, ...save } = data; await setDoc(doc(db, 'clients', reg.cid, 'dsc', reg.id), save);
      Object.assign(reg, data); render();
    }, 'Register updated from the token');
  };
  C.dscCertFile = el => { const f = el.files[0]; el.value = ''; if (!f) return; guard(async () => { const c = await parseCertFile(f); const reg = inReg(c); if (reg) { (S.dscLive ||= { certs: [] }).certs = [...(S.dscLive.certs || []).filter(x => x.thumb !== c.thumb), c]; S.dscLive.state ||= 'ok'; } if (reg) { A.dscEdit({ id: reg.id, cid: reg.cid }); toast(`Already in the register — valid till ${isoToDisp(c.to)} on the certificate.`, 6000); } else fromCert(c); }); };
  function table(list, withClient) {
    if (!list.length) return `<div class="empty-state small">${withClient ? 'No DSCs match. Add the tokens you keep for clients with "+ Add DSC".' : 'No DSC recorded for this client.'}</div>`;
    return `<div class="reg-wrap"><table class="reg"><thead><tr><th class="srn">Sr.</th><th>Holder</th>${withClient ? '<th>Client</th>' : ''}<th>Class / issuer</th><th>Valid till</th><th>Token PIN</th><th>Custody</th><th></th></tr></thead><tbody>
      ${list.map((x, i) => { const [cls, txt] = validity(x), last = (x.moves || [])[(x.moves || []).length - 1]; return `<tr class="${cls === 'late' ? 'late' : ''}">
        <td class="srn">${i + 1}</td>
        <td><a href="#" class="cl" data-act="dscEdit" data-id="${x.id}" data-cid="${x.cid}">${esc(x.holder || '—')}</a><div class="sub">${esc(x.role || '')}${x.pan ? ` · <span class="mono">${esc(x.pan)}</span>` : ''}${x.mobile ? ' · ' + esc(x.mobile) : ''}</div></td>
        ${withClient ? `<td><a href="#" data-act="open" data-id="${x.cid}">${esc(cName(x.cid))}</a></td>` : ''}
        <td class="small">${esc(x.cls || '')}<div class="sub">${esc(x.issuer || '')}${x.token ? ' · ' + esc(x.token) : ''}${x.serial ? ` · <span class="mono">${esc(x.serial)}</span>` : ''}</div></td>
        <td class="nowrap">${isoToDisp(x.validTo) || '—'} <span class="dd ${cls === 'late' ? 'late' : cls === 'soon' ? 'soon' : ''}">${txt}</span>${x.status === 'Inactive' ? '<div class="sub">Inactive</div>' : ''}</td>
        <td class="nowrap">${x.pin ? `<span class="mono pin" data-pin="${esc(x.pin)}">••••••</span> <button class="icon" data-act="dscPin" title="Show / copy PIN">👁</button>` : '<span class="muted">—</span>'}</td>
        <td class="nowrap"><span class="st ${x.custody === 'In office' ? 'cp' : x.custody === 'With client' ? 'wc' : 'ns'}">${esc(x.custody || '—')}</span>${x.location ? `<div class="sub">${esc(x.location)}</div>` : ''}${last ? `<div class="sub">${last.type === 'out' ? 'Given to' : 'Received from'} ${esc(last.who || '')} · ${isoToDisp(last.on)}</div>` : ''}</td>
        <td class="nowrap">${isAdmin() ? `<button class="sm" data-act="dscMove" data-id="${x.id}" data-cid="${x.cid}">${x.custody === 'In office' ? 'Give out' : 'Receive'}</button>
          ${cls === 'late' || cls === 'soon' ? `<span class="rbtns"><button class="rb wa ${x.mobile ? '' : 'off'}" data-act="dscRemind" data-id="${x.id}" data-cid="${x.cid}" data-via="wa" title="Renewal reminder on WhatsApp">${WA_ICON}</button><button class="rb em ${x.email ? '' : 'off'}" data-act="dscRemind" data-id="${x.id}" data-cid="${x.cid}" data-via="mail" title="Renewal reminder by email">${MAIL_ICON}</button></span>` : ''}` : ''}</td></tr>`; }).join('')}
      </tbody></table></div>`;
  }

  /* ---------- client page tab ---------- */
  D.clientTab = () => {
    const cid = S.cid;
    if (!S.dsc) { D.loadAll().then(render); return '<p class="muted">Loading…</p>'; }
    const list = S.dsc.filter(x => x.cid === cid).sort((a, b) => (a.validTo || '9999').localeCompare(b.validTo || '9999'));
    return `<div class="row-between wrap"><h2>DSC</h2>${isAdmin() ? `<button class="primary" data-act="dscEdit" data-cid="${cid}">+ Add DSC</button>` : ''}</div>${table(list, false)}`;
  };

  /* ---------- add / edit ---------- */
  A.dscEdit = ({ id, cid }) => {
    const x = (S.dsc || []).find(d => d.id === id) || { cid: cid || '', custody: 'In office', cls: CLASSES[0], status: 'Active', ...(S.dscPrefill || {}) };
    S.dscPrefill = null;
    const opt = (arr, v) => arr.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('');
    const c = S.clients.find(y => y.id === x.cid);
    modal(`<h2>${id ? 'Edit DSC' : x.certThumb ? 'Add DSC — read from the token' : 'Add DSC'}</h2><form data-form="dscSave" data-id="${id || ''}" class="grid"><input type="hidden" name="certThumb" value="${esc(x.certThumb || '')}"><input type="hidden" name="certSerial" value="${esc(x.certSerial || '')}">
      <label class="span2">Client<input name="client" list="dscClients" required autocomplete="off" value="${c ? esc(c.name) : ''}" placeholder="Type client name, PAN or GSTIN"></label>
      <datalist id="dscClients">${S.clients.map(y => `<option value="${esc(y.name)}">`).join('')}</datalist>
      <label>Holder name<input name="holder" required value="${esc(x.holder || '')}"></label>
      <label>Role<select name="role">${opt(ROLES, x.role)}</select></label>
      <label>Holder PAN<input name="pan" class="mono up" value="${esc(x.pan || '')}"></label>
      <label>Mobile<input name="mobile" value="${esc(x.mobile || '')}"></label>
      <label>Email<input name="email" type="email" value="${esc(x.email || '')}"></label>
      <label>Class<select name="cls">${opt(CLASSES, x.cls)}</select></label>
      <label>Issued by<select name="issuer"><option value=""></option>${opt(ISSUERS, x.issuer)}</select></label>
      <label>Token<select name="token"><option value=""></option>${opt(TOKENS, x.token)}</select></label>
      <label>Token serial no.<input name="serial" class="mono" value="${esc(x.serial || '')}"></label>
      <label>Token PIN / password<input name="pin" value="${esc(x.pin || '')}" autocomplete="off"></label>
      <label>Valid from<input type="date" name="validFrom" value="${esc(x.validFrom || '')}"></label>
      <label>Valid till<input type="date" name="validTo" value="${esc(x.validTo || '')}"></label>
      <label>Custody<select name="custody">${opt(CUSTODY, x.custody)}</select></label>
      <label>Kept at (drawer / box)<input name="location" value="${esc(x.location || '')}"></label>
      <label>Status<select name="status">${opt(['Active', 'Inactive'], x.status || 'Active')}</select></label>
      <label class="span2">Notes<input name="notes" value="${esc(x.notes || '')}" placeholder="e.g. Used for MCA and GST; renewal through eMudhra partner"></label>
      ${(x.moves || []).length ? `<div class="span2"><b class="small">Movement log</b><div class="log">${x.moves.slice().reverse().map(m => `<div class="small">${isoToDisp(m.on)} — ${m.type === 'out' ? 'Given to' : 'Received from'} <b>${esc(m.who)}</b>${m.note ? ' · ' + esc(m.note) : ''} <span class="muted tiny">(${esc(m.by || '')})</span></div>`).join('')}</div></div>` : ''}
      <div class="span2 btns"><button class="primary">Save</button>${id ? '<button type="button" class="danger" data-act="dscDel" data-id="' + id + '" data-cid="' + x.cid + '">Delete</button>' : ''}<button type="button" data-act="closeModal">Cancel</button></div></form>`);
  };
  const pick = v => { const s = (v || '').trim().toLowerCase(); return S.clients.find(c => (c.name || '').toLowerCase() === s) || S.clients.find(c => [c.pan, ...(c.gstins || [])].some(p => p && p.toLowerCase() === s)) || S.clients.find(c => (c.name || '').toLowerCase().includes(s)); };
  F.dscSave = (fd, form) => guard(async () => {
    const c = pick(fd.get('client')); if (!c) throw new Error('Pick the client from the list.');
    const id = form.dataset.id, old = (S.dsc || []).find(d => d.id === id);
    const data = Object.fromEntries(['holder', 'role', 'pan', 'mobile', 'email', 'cls', 'issuer', 'token', 'serial', 'pin', 'validFrom', 'validTo', 'custody', 'location', 'status', 'notes', 'certThumb', 'certSerial'].map(k => [k, (fd.get(k) || '').trim()]));
    data.pan = data.pan.toUpperCase(); data.moves = old?.moves || []; data.updatedAt = new Date().toISOString();
    if (old && old.cid !== c.id) await deleteDoc(doc(db, 'clients', old.cid, 'dsc', id)); // moved to another client
    const ref = id && old?.cid === c.id ? doc(db, 'clients', c.id, 'dsc', id) : doc(collection(db, 'clients', c.id, 'dsc'));
    await setDoc(ref, data);
    S.dsc = (S.dsc || []).filter(d => d.id !== id).concat({ id: ref.id, cid: c.id, ...data });
    closeModal(); render();
  }, 'DSC saved');
  A.dscDel = ({ id, cid }) => { if (!confirm('Delete this DSC from the register?')) return; guard(async () => { await deleteDoc(doc(db, 'clients', cid, 'dsc', id)); S.dsc = S.dsc.filter(d => d.id !== id); closeModal(); render(); }, 'DSC deleted'); };

  /* ---------- token in / out ---------- */
  A.dscMove = ({ id, cid }) => {
    const x = S.dsc.find(d => d.id === id), out = x.custody === 'In office';
    modal(`<h2>${out ? 'Give out' : 'Receive'} DSC — ${esc(x.holder)}</h2><form data-form="dscMoveSave" data-id="${id}" data-out="${out ? 1 : ''}" class="grid">
      <label>${out ? 'Given to' : 'Received from'}<input name="who" required value="${esc(out ? x.holder : (x.moves || []).slice(-1)[0]?.who || x.holder)}"></label>
      <label>Date<input type="date" name="on" value="${todayISO()}" required></label>
      ${out ? `<label>Now with<select name="custody"><option>With client</option><option>With other CA</option></select></label>` : '<input type="hidden" name="custody" value="In office">'}
      <label class="${out ? '' : 'span2'}">Note<input name="note" placeholder="${out ? 'e.g. for MCA filing at client office' : 'e.g. returned with PIN changed'}"></label>
      <div class="span2 btns"><button class="primary">${out ? 'Record hand-over' : 'Record receipt'}</button><button type="button" data-act="closeModal">Cancel</button></div></form>`);
  };
  F.dscMoveSave = (fd, form) => guard(async () => {
    const x = S.dsc.find(d => d.id === form.dataset.id);
    const m = { type: form.dataset.out ? 'out' : 'in', who: fd.get('who').trim(), on: fd.get('on'), note: fd.get('note').trim(), by: S.profile?.name || S.profile?.email || '' };
    const upd = { custody: fd.get('custody'), moves: [...(x.moves || []), m], updatedAt: new Date().toISOString() };
    await setDoc(doc(db, 'clients', x.cid, 'dsc', x.id), upd, { merge: true }); Object.assign(x, upd); closeModal(); render();
  }, 'Recorded in the movement log');

  /* ---------- PIN, reminders, export, filters ---------- */
  A.dscPin = (_, el) => { const s = el.parentElement.querySelector('.pin'); const shown = s.textContent !== '••••••'; s.textContent = shown ? '••••••' : s.dataset.pin; if (!shown) navigator.clipboard?.writeText(s.dataset.pin).then(() => toast('PIN copied')); };
  A.dscRemind = ({ id, via }) => {
    const x = S.dsc.find(d => d.id === id), n = days(x.validTo);
    const text = [`Dear ${x.holder},`, '', `Your Digital Signature Certificate (${x.cls}${x.issuer ? ', ' + x.issuer : ''}) ${n < 0 ? `expired on ${isoToDisp(x.validTo)}` : `expires on ${isoToDisp(x.validTo)}`}.`,
      'Please arrange renewal so that filings for ' + cName(x.cid) + ' are not held up. We can process the renewal for you — reply to proceed.', '', 'Regards,', S.firm || ''].join('\n');
    if (via === 'wa') { if (!x.mobile) return toast('Add the holder\'s mobile in the DSC record'); window.open(`https://wa.me/${waNum(x.mobile)}?text=${encodeURIComponent(text)}`, '_blank', 'noopener'); }
    else { if (!x.email) return toast('Add the holder\'s email in the DSC record'); window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(x.email)}&su=${encodeURIComponent('DSC renewal — ' + x.holder)}&body=${encodeURIComponent(text)}`, '_blank', 'noopener'); }
  };
  A.dscExport = () => {
    const rows = [['Sr', 'Holder', 'Role', 'Holder PAN', 'Client', 'Class', 'Issuer', 'Token', 'Serial no.', 'Valid from', 'Valid till', 'Status', 'Custody', 'Kept at', 'Mobile', 'Email', 'Notes'],
      ...(S.dsc || []).slice().sort((a, b) => (a.validTo || '9999').localeCompare(b.validTo || '9999')).map((x, i) => [i + 1, x.holder, x.role, x.pan, cName(x.cid), x.cls, x.issuer, x.token, x.serial, isoToDisp(x.validFrom), isoToDisp(x.validTo), validity(x)[1], x.custody, x.location, x.mobile, x.email, x.notes])];
    const ws = XLSX.utils.aoa_to_sheet(rows), wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'DSC register'); XLSX.writeFile(wb, `DSC-register-${todayISO()}.xlsx`);
  };
  A.dscF = ({ k, v }) => { const f = S.dscF; if (k === 'show') { f.show = v; f.cust = ''; } else { f.cust = f.cust === v ? '' : v; f.show = ''; } render(); };
  A.dscClear = () => { S.dscF = { q: '', show: '', cust: '' }; render(); };
  C.dscShow = el => { S.dscF.show = el.value; render(); };
  return D;
}
