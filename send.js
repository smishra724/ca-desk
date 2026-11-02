// Send a client's master details and documents on WhatsApp or by email.
// Static site, so nothing is sent from a server: on phones (and Chrome/Edge on Windows) the system share
// sheet attaches the real files to WhatsApp / Gmail; elsewhere the files are downloaded and WhatsApp
// or the mail app opens with the message filled in, ready for the files to be attached.

const KYC = new Set(['GST Certificate', 'PAN Card', 'TAN Allotment', 'Aadhaar', 'Certificate of Incorporation', 'LLP Incorporation',
  'Partnership Deed / LLP Agreement', 'MOA / AOA']);

export function initSend(ctx) {
  const { S, A, C, esc, toast, modal, closeModal, regsOf, stateOf, isoToDisp, fmtDate, db, fs, saveBlob } = ctx;
  const { doc, getDocs, collection, updateDoc, arrayUnion } = fs;
  const cache = new Map(); // doc id -> File
  const me = () => S.profile?.name || S.profile?.email || 'Owner';

  const phone = s => { const d = String(s || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d.replace(/^0+/, ''); };
  const canShareFiles = () => !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] }));

  function masterText(c, docs) {
    const regs = regsOf(c);
    const L = [];
    L.push(`Dear ${c.name || 'Sir/Madam'},`, '', 'Please find your registration details below:', '');
    L.push(`Legal name: ${c.name || ''}`);
    if (c.tradeName) L.push(`Trade name: ${c.tradeName}`);
    if (c.constitution) L.push(`Constitution: ${c.constitution}`);
    if (c.pan) L.push(`PAN: ${c.pan}`);
    if (regs.length === 1) L.push(`GSTIN: ${regs[0].gstin}${regs[0].state ? ` (${regs[0].state})` : ''}`);
    else if (regs.length) { L.push('GSTINs:'); for (const r of regs) L.push(`  • ${r.gstin} — ${r.state || stateOf(r.gstin)}${r.status === 'Cancelled' ? ' (cancelled)' : ''}`); }
    if (c.tan) L.push(`TAN: ${c.tan}`);
    if (c.cin) L.push(`CIN / LLPIN: ${c.cin}`);
    if (c.doi) L.push(`Date of incorporation / birth: ${isoToDisp(c.doi)}`);
    if (c.address) L.push(`Address: ${c.address.replace(/\n/g, ', ')}`);
    if (docs.length) { L.push('', 'Documents attached:'); for (const d of docs) L.push(`  • ${d.category} — ${d.name}`); }
    L.push('', 'Regards,', S.firm || '');
    return L.join('\n');
  }

  async function fileFor(cid, d) {
    if (cache.has(d.id)) return cache.get(d.id);
    const chunks = await getDocs(collection(db, 'clients', cid, 'docs', d.id, 'chunks'));
    const b64 = chunks.docs.sort((a, b) => a.id.localeCompare(b.id)).map(x => x.data().d).join('');
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const f = new File([u8], d.name, { type: d.mime || 'application/octet-stream' });
    cache.set(d.id, f); return f;
  }
  const picked = () => [...document.querySelectorAll('#sendDocs input:checked')].map(i => S.docs.find(d => d.id === i.value)).filter(Boolean);
  // fetch selected files in the background so the share sheet can open straight from the click
  async function prefetch() {
    const st = document.getElementById('sendFileState'); if (!st) return;
    const list = picked();
    if (!list.length) { st.textContent = ''; return; }
    st.textContent = 'Preparing files…';
    try { for (const d of list) await fileFor(S.cid, d); st.textContent = `${list.length} file(s) ready.`; }
    catch (e) { st.textContent = 'Could not load a file: ' + e.message; }
  }
  const refreshText = () => {
    const ta = document.getElementById('sendMsg');
    if (ta && !ta.dataset.edited) ta.value = masterText(S.client, picked());
  };

  A.sendOpen = ({ ids }) => {
    const c = S.client || {};
    const pre = ids ? new Set(ids.split(',')) : null;
    const share = canShareFiles();
    modal(`<h2>Send to client</h2>
      <div class="grid">
        <label>WhatsApp number<input id="sendPhone" value="${esc(c.mobile || '')}" placeholder="10-digit mobile"></label>
        <label>Email<input id="sendEmail" type="email" value="${esc(c.email || '')}" placeholder="client@example.com"></label>
        <div class="span2"><h3>Documents</h3>
          <div id="sendDocs" class="senddocs">${S.docs.map(d => `<label class="chk"><input type="checkbox" value="${d.id}" data-change="sendPick"
            ${pre ? (pre.has(d.id) ? 'checked' : '') : (KYC.has(d.category) ? 'checked' : '')}> ${esc(d.category)} — ${esc(d.name)} <span class="muted tiny">${(d.size / 1024).toFixed(0)} KB</span></label>`).join('')
            || '<p class="muted small">No documents uploaded yet — only the master details will be sent.</p>'}</div>
          <div id="sendFileState" class="muted tiny"></div></div>
        <label class="span2">Message<textarea id="sendMsg" rows="12" data-change="sendEdit"></textarea></label>
      </div>
      <p class="muted small">${share
        ? 'WhatsApp and Email open your device’s share menu with the files attached — pick WhatsApp or your mail app.'
        : 'The selected files will download, and WhatsApp / your mail opens with the message filled in. Attach the downloaded files there (drag them from the Downloads bar).'}</p>
      <div class="btns">
        <button class="primary wa" data-act="sendWA">Send on WhatsApp</button>
        <button class="primary" data-act="sendMail" data-via="mail">Send by Email</button>
        <button data-act="sendMail" data-via="gmail">Open in Gmail</button>
        <button data-act="closeModal">Cancel</button>
      </div>
      ${(c.sentLog || []).length ? `<h3 class="mt">Recently sent</h3><div class="log">${c.sentLog.slice(-5).reverse().map(l =>
        `<div class="small"><span class="muted tiny">${fmtDate(new Date(l.at))} · ${esc(l.by)}</span><br>${esc(l.channel)} to ${esc(l.to)} — ${l.docs.length} document(s)</div>`).join('')}</div>` : ''}`);
    refreshText(); prefetch();
  };

  C.sendPick = () => { refreshText(); prefetch(); };
  C.sendEdit = el => { el.dataset.edited = '1'; };
  document.addEventListener('input', e => { if (e.target.id === 'sendMsg') e.target.dataset.edited = '1'; });

  async function logSent(channel, to, docs) {
    const entry = { at: new Date().toISOString(), by: me(), channel, to, docs: docs.map(d => d.name) };
    try { await updateDoc(doc(db, 'clients', S.cid), { sentLog: arrayUnion(entry) }); (S.client.sentLog ||= []).push(entry); } catch (e) { console.warn(e); }
  }
  async function downloadAll(docs) {
    for (const d of docs) { saveBlob(await fileFor(S.cid, d), d.name); await new Promise(r => setTimeout(r, 350)); }
  }
  // use the share sheet (real attachments) only when every selected file is already loaded,
  // so it opens within the click; otherwise open WhatsApp/mail straight away and download the files
  const shareable = docs => docs.length && canShareFiles() && docs.every(d => cache.has(d.id))
    && navigator.canShare({ files: docs.map(d => cache.get(d.id)) });
  function share(docs, text, title, channel, to) {
    navigator.share({ files: docs.map(d => cache.get(d.id)), text, title })
      .then(() => { logSent(channel, to || 'share menu', docs); closeModal(); })
      .catch(e => { if (e.name !== 'AbortError') toast('Sharing failed: ' + e.message, 6000); });
  }
  async function fallbackFiles(docs) {
    if (!docs.length) return;
    try { await downloadAll(docs); toast(`${docs.length} file(s) downloaded — attach them (📎 or drag from Downloads).`, 8000); }
    catch (e) { toast('Could not download a file: ' + e.message, 6000); }
  }

  A.sendWA = () => {
    const num = phone(document.getElementById('sendPhone').value);
    const text = document.getElementById('sendMsg').value, docs = picked();
    if (shareable(docs)) return share(docs, text, S.client.name, 'WhatsApp', num);
    if (!num) return toast('Enter the client’s WhatsApp number.');
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    logSent('WhatsApp', num, docs); fallbackFiles(docs); closeModal();
  };

  A.sendMail = ({ via }) => {
    const to = document.getElementById('sendEmail').value.trim();
    const text = document.getElementById('sendMsg').value, docs = picked();
    const subject = `${S.client.name || 'Your'} — registration details${docs.length ? ' and documents' : ''}`;
    if (via === 'mail' && shareable(docs)) return share(docs, text, subject, 'Email', to);
    if (via === 'gmail') window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`, '_blank', 'noopener');
    else location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
    logSent(via === 'gmail' ? 'Gmail' : 'Email', to || '—', docs); fallbackFiles(docs); closeModal();
  };

  // Documents tab: tick documents, then "Send selected"
  A.sendSelected = () => {
    const ids = [...document.querySelectorAll('.docpick:checked')].map(i => i.value);
    if (!ids.length) return toast('Tick the documents to send first.');
    A.sendOpen({ ids: ids.join(',') });
  };
  C.docpickAll = el => document.querySelectorAll('.docpick').forEach(i => i.checked = el.checked);

  return { clear: () => cache.clear() };
}
