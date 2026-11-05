// Files on a task: the client's input data, our working, and the final output (returns, acknowledgements).
// Files are browsed from the computer, saved in the client's Documents (tagged to the task) and can be sent
// to the client from here on WhatsApp or email. The client sees them in their login and can add input data.

const KINDS = [
  ['input', 'Input data', 'Sales/purchase registers, bank statements, Form 16, bills — what the client sent'],
  ['working', 'Working', 'Computations, reconciliations, draft returns'],
  ['output', 'Output', 'Filed return, acknowledgement, challan, certificate'],
];
const CAT = { input: 'Input data', working: 'Working', output: 'Output' };

export function initTaskFiles(ctx) {
  const { S, A, C, esc, toast, modal, closeModal, guard, render, isAdmin, isoToDisp, db, fs, saveFile, saveBlob, T, WA_ICON, MAIL_ICON } = ctx;
  const { doc, getDocs, deleteDoc, collection, query, where } = fs;
  const TF = {};
  const waNum = s => { const d = String(s || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d.replace(/^0+/, ''); };
  const size = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const me = () => S.profile?.name || S.profile?.email || '';

  async function load(t) {
    S.tfiles = { tid: t.id, loading: true, list: [] };
    const snap = await getDocs(query(collection(db, 'clients', t.clientId, 'docs'), where('taskId', '==', t.id)));
    S.tfiles = { tid: t.id, loading: false, list: snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.uploadedAt?.seconds || 0) - (a.uploadedAt?.seconds || 0)) };
    S.tfSel = new Set();
  }
  async function fileOf(t, d) {
    const ch = await getDocs(collection(db, 'clients', t.clientId, 'docs', d.id, 'chunks'));
    const b64 = ch.docs.sort((a, b) => a.id.localeCompare(b.id)).map(x => x.data().d).join('');
    return new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], d.name, { type: d.mime || 'application/octet-stream' });
  }

  TF.section = t => {
    if (!t?.clientId) return '';
    if (S.tfiles?.tid !== t.id) { if (!S.tfiles?.loading || S.tfiles.tid !== t.id) load(t).then(render).catch(e => { S.tfiles = null; toast(e.message); }); return `<section class="card tfiles"><h2>Files</h2><p class="muted">Loading…</p></section>`; }
    const adm = isAdmin(), list = S.tfiles.list, sel = S.tfSel || new Set();
    const col = ([k, label, hint]) => {
      const fs_ = list.filter(d => d.kind === k);
      const canUp = adm || k === 'input';
      return `<div class="tf-col"><div class="tf-h"><b>${label}</b><span class="cnt">${fs_.length}</span></div>
        ${fs_.map(d => `<div class="tf-f ${sel.has(d.id) ? 'sel' : ''}">${adm ? `<input type="checkbox" data-change="tfSel" value="${d.id}" ${sel.has(d.id) ? 'checked' : ''} aria-label="Select ${esc(d.name)}">` : ''}
          <a href="#" data-act="tfOpen" data-id="${d.id}" title="Open">${esc(d.name)}</a>
          <span class="muted tiny">${size(d.size || 0)} · ${d.uploadedAt?.seconds ? isoToDisp(new Date(d.uploadedAt.seconds * 1000).toISOString().slice(0, 10)) : ''}${d.byRole === 'client' ? ' · from client' : ''}${(d.sent || []).length ? ' · sent' : ''}</span>
          ${adm ? `<button class="icon" data-act="tfDel" data-id="${d.id}" title="Remove" aria-label="Remove ${esc(d.name)}">✕</button>` : ''}</div>`).join('') || `<p class="muted tiny tf-empty">${hint}</p>`}
        ${canUp ? `<label class="tf-drop" data-kind="${k}">+ Browse files<input type="file" multiple data-change="tfUp" data-kind="${k}"></label>` : ''}</div>`;
    };
    const n = sel.size;
    return `<section class="card tfiles">
      <div class="row-between wrap"><h2>Files</h2>
        ${adm ? `<div class="btns">${n ? `<span class="small"><b>${n}</b> selected</span>` : '<span class="muted small">Tick files to send them to the client</span>'}
          <button class="sm wa" data-act="tfSend" data-via="wa" ${n ? '' : 'disabled'}>${WA_ICON} WhatsApp</button><button class="sm" data-act="tfSend" data-via="mail" ${n ? '' : 'disabled'}>${MAIL_ICON} Email</button></div>` : ''}</div>
      <div class="tf-grid">${KINDS.map(col).join('')}</div>
      <p class="muted tiny">Files are also kept in the client's Documents tab${adm ? ' and visible to the client in their login' : ''}. Up to 10 MB each.</p>
    </section>`;
  };

  C.tfUp = el => {
    const files = [...el.files], kind = el.dataset.kind; el.value = ''; if (!files.length) return;
    const t = S.tasks.find(x => x.id === S.task);
    guard(async () => {
      for (const f of files) { ctx.busy(true, `Uploading ${f.name}…`); await saveFile(t.clientId, f, CAT[kind], { taskId: t.id, filingKey: t.filingKey || '', kind, byRole: isAdmin() ? 'ca' : 'client' }); }
      ctx.busy(false);
      if (T.patch && isAdmin()) await T.patch(t.id, {}, `${CAT[kind]} uploaded: ${files.map(f => f.name).join(', ')}`);
      await load(t); render();
    }, `${files.length} file(s) saved`);
  };
  C.tfSel = el => { S.tfSel ||= new Set(); el.checked ? S.tfSel.add(el.value) : S.tfSel.delete(el.value); render(); };
  A.tfOpen = ({ id }) => guard(async () => {
    const t = S.tasks.find(x => x.id === S.task), d = S.tfiles.list.find(x => x.id === id), f = await fileOf(t, d);
    if (/pdf|image|text/.test(f.type)) window.open(URL.createObjectURL(f), '_blank'); else saveBlob(f, f.name);
  });
  A.tfDel = ({ id }) => {
    const d = S.tfiles.list.find(x => x.id === id); if (!confirm(`Remove ${d.name} from this task and the client's documents?`)) return;
    const t = S.tasks.find(x => x.id === S.task);
    guard(async () => {
      for (const c of (await getDocs(collection(db, 'clients', t.clientId, 'docs', id, 'chunks'))).docs) await deleteDoc(c.ref);
      await deleteDoc(doc(db, 'clients', t.clientId, 'docs', id)); await load(t); render();
    }, 'File removed');
  };
  A.tfSend = ({ via }) => {
    const t = S.tasks.find(x => x.id === S.task), c = S.clients.find(x => x.id === t.clientId) || {};
    const docs = S.tfiles.list.filter(d => S.tfSel?.has(d.id));
    const text = [`Dear ${c.name || 'Sir/Madam'},`, '', `Please find attached the following for ${t.title}${t.period ? ' — ' + t.period : ''}:`,
      ...docs.map(d => `• ${d.name} (${CAT[d.kind] || d.category})`), '', 'Regards,', S.firm || ''].join('\n');
    modal(`<h2>Send ${docs.length} file${docs.length === 1 ? '' : 's'} to ${esc(c.name || 'client')}</h2>
      <div class="grid">${via === 'wa' ? `<label class="span2">WhatsApp number<input id="tfTo" value="${esc(c.mobile || '')}" placeholder="10-digit mobile"></label>` : `<label class="span2">Email<input id="tfTo" type="email" value="${esc(c.email || '')}"></label>`}
        <label class="span2">Message<textarea id="tfMsg" rows="9">${esc(text)}</textarea></label></div>
      <p class="muted small">On a phone the files attach straight to ${via === 'wa' ? 'WhatsApp' : 'the email'}. On a computer they are downloaded and ${via === 'wa' ? 'WhatsApp' : 'Gmail'} opens with the message — drag the files in and send.</p>
      <div class="btns mt"><button class="primary ${via === 'wa' ? 'wa' : ''}" data-act="tfSendGo" data-via="${via}">${via === 'wa' ? WA_ICON + ' Send on WhatsApp' : MAIL_ICON + ' Send with Gmail'}</button><button data-act="closeModal">Cancel</button></div>`);
  };
  A.tfSendGo = ({ via }) => guard(async () => {
    const t = S.tasks.find(x => x.id === S.task), to = document.getElementById('tfTo').value.trim(), text = document.getElementById('tfMsg').value;
    if (!to) throw new Error(via === 'wa' ? 'Enter the WhatsApp number.' : 'Enter the email address.');
    const docs = S.tfiles.list.filter(d => S.tfSel?.has(d.id)); ctx.busy(true, 'Preparing files…');
    const files = []; for (const d of docs) files.push(await fileOf(t, d)); ctx.busy(false);
    let shared = false;
    if (navigator.canShare?.({ files })) { try { await navigator.share({ files, text, title: t.title }); shared = true; } catch (e) { if (e.name === 'AbortError') return; } }
    if (!shared) {
      for (const f of files) saveBlob(f, f.name);
      if (via === 'wa') window.open(`https://wa.me/${waNum(to)}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      else window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(`${t.title}${t.period ? ' — ' + t.period : ''}`)}&body=${encodeURIComponent(text)}`, '_blank', 'noopener');
    }
    if (T.patch) await T.patch(t.id, {}, `Sent to client on ${via === 'wa' ? 'WhatsApp' : 'email'} (${to}): ${docs.map(d => d.name).join(', ')}`);
    S.tfSel = new Set(); closeModal(); render(); toast(shared ? 'Shared' : `${files.length} file(s) downloaded — attach them in ${via === 'wa' ? 'WhatsApp' : 'Gmail'}`);
  });
  return TF;
}
