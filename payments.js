// Payment-type compliances (TDS/TCS payment, GST PMT-06, EPF, ESIC, PT, LWF, advance tax).
// Flow: CA uploads the working sheet → shares it with the client for payment → the client (from their own
// login) or the CA uploads the paid challan with the payment date → the task closes and the due date is
// marked paid. Files are kept in the client's Documents ("Payment working" / "Payment challan").

export const PAY_CODES = new Set(['TDSPAY', 'PMT06', 'EPF', 'ESIC', 'PT', 'LWF', 'ADV']);
export const payCode = key => { const p = String(key || '').split('@')[0].split('-')[0]; return /^ADV\d$/.test(p) ? 'ADV' : p; };
export const isPayKey = key => PAY_CODES.has(payCode(key));

export function initPayments(ctx) {
  const { S, A, C, F, esc, toast, modal, closeModal, guard, render, isAdmin, isoToDisp, todayISO, db, fs, saveFile, saveBlob, T, WA_ICON, MAIL_ICON } = ctx;
  const { doc, getDocs, setDoc, collection } = fs;
  const P = {};
  const inr = n => '₹' + (+n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const waNum = s => { const d = String(s || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d.replace(/^0+/, ''); };
  const me = () => S.profile?.name || S.profile?.email || (isAdmin() ? 'Owner' : 'Client');
  const clientOf = t => S.clients.find(c => c.id === t.clientId) || (S.client?.id === t.clientId ? S.client : {}) || {};

  P.isPay = t => !!t && (isPayKey(t.filingKey) || PAY_CODES.has(t.catId));

  async function fileOf(cid, d) {
    const ch = await getDocs(collection(db, 'clients', cid, 'docs', d.docId, 'chunks'));
    const b64 = ch.docs.sort((a, b) => a.id.localeCompare(b.id)).map(x => x.data().d).join('');
    return new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], d.name, { type: d.mime || 'application/octet-stream' });
  }
  async function upload(t, file, category) {
    const before = Date.now(); const id = await saveFile(t.clientId, file, category, { taskId: t.id, filingKey: t.filingKey || '', byRole: isAdmin() ? 'ca' : 'client' });
    return { docId: id, name: file.name, mime: file.type || '', at: new Date(before).toISOString(), by: me() };
  }

  /* ---------- the payment card on the task page (CA and client) ---------- */
  P.card = t => {
    if (!P.isPay(t)) return '';
    const p = t.pay || {}, adm = isAdmin(), done = t.status === 'Completed';
    const w = p.work, ch = p.challan, last = (p.shared || [])[(p.shared || []).length - 1];
    return `<section class="card paycard">
      <div class="row-between wrap"><h2>Payment${p.amount ? ` — ${inr(p.amount)}` : ''}</h2>
        <span class="tag ${ch ? 'green' : last ? 'amber' : ''}">${ch ? `Paid on ${isoToDisp(ch.paidOn)}` : last ? 'Waiting for client to pay' : w ? 'Working ready' : 'Working not prepared'}</span></div>
      <ol class="paysteps">
        <li class="${w ? 'ok' : ''}"><b>Working sheet</b>
          ${w ? `<div class="pf"><a href="#" data-act="payOpen" data-tid="${t.id}" data-w="work">${esc(w.name)}</a><span class="muted tiny">uploaded ${isoToDisp(w.at.slice(0, 10))} by ${esc(w.by)}</span></div>` : '<div class="muted small">Upload the computation (Excel or PDF) showing the amount to pay.</div>'}
          ${adm && !done ? `<div class="row wrap mt6"><label class="small">Amount payable (₹)<input type="number" min="0" step="1" id="payAmt" value="${p.amount || ''}" style="width:150px"></label>
            <label class="filebtn ghostbtn sm">${w ? 'Replace working' : 'Upload working'}<input type="file" data-change="payWork" data-tid="${t.id}"></label></div>` : ''}</li>
        <li class="${last ? 'ok' : ''}"><b>Shared with client for payment</b>
          ${last ? `<div class="muted tiny">Sent ${isoToDisp(last.at.slice(0, 10))} on ${last.via === 'wa' ? 'WhatsApp' : 'email'} to ${esc(last.to)}</div>` : ''}
          ${adm && !done && w ? `<div class="rbtns mt6"><button class="sm wa" data-act="payShare" data-tid="${t.id}" data-via="wa">${WA_ICON} Send on WhatsApp</button><button class="sm" data-act="payShare" data-tid="${t.id}" data-via="mail">${MAIL_ICON} Send by email</button></div>` : ''}</li>
        <li class="${ch ? 'ok' : ''}"><b>Challan uploaded &amp; task closed</b>
          ${ch ? `<div class="pf"><a href="#" data-act="payOpen" data-tid="${t.id}" data-w="challan">${esc(ch.name)}</a><span class="muted tiny">Paid ${isoToDisp(ch.paidOn)}${ch.amount ? ' · ' + inr(ch.amount) : ''}${ch.no ? ' · Challan ' + esc(ch.no) : ''} · uploaded by ${esc(ch.by)}${ch.byRole === 'client' ? ' (client)' : ''}</span></div>`
            : `<div class="muted small">${adm ? 'Once paid, upload the challan here — or the client can upload it from their login.' : 'After paying, upload the challan here. Your CA is notified and the task is closed.'}</div>
               <button class="primary mt6" data-act="payChallan" data-tid="${t.id}">Upload challan &amp; mark paid</button>`}</li>
      </ol></section>`;
  };

  C.payWork = el => {
    const t = S.tasks.find(x => x.id === el.dataset.tid), f = el.files[0]; el.value = ''; if (!f) return;
    guard(async () => {
      const w = await upload(t, f, 'Payment working');
      const amount = +document.getElementById('payAmt')?.value || t.pay?.amount || 0;
      await T.patch(t.id, { pay: { ...(t.pay || {}), work: w, amount }, ...(t.status === 'Not started' ? { status: 'In progress' } : {}) }, `Working sheet uploaded: ${f.name}${amount ? ` (${inr(amount)})` : ''}`);
      render();
    }, 'Working sheet uploaded');
  };

  A.payOpen = ({ tid, w }) => guard(async () => {
    const t = S.tasks.find(x => x.id === tid), d = t.pay?.[w]; const f = await fileOf(t.clientId, d);
    if (/pdf|image/.test(f.type)) window.open(URL.createObjectURL(f), '_blank'); else saveBlob(f, f.name);
  });

  A.payShare = ({ tid, via }) => guard(async () => {
    const t = S.tasks.find(x => x.id === tid), c = clientOf(t), p = t.pay || {};
    const amount = +document.getElementById('payAmt')?.value || p.amount || 0;
    const to = via === 'wa' ? c.mobile : c.email;
    if (!to) throw new Error(`Add the client's ${via === 'wa' ? 'mobile number' : 'email'} on their Master data first.`);
    const text = [`Dear ${c.name || 'Sir/Madam'},`, '', `Please find attached the working for ${t.title}${t.period ? ' — ' + t.period : ''}.`,
      amount ? `Amount payable: ${inr(amount)}` : '', t.due ? `Due date: ${isoToDisp(t.due)}` : '', '',
      'Kindly make the payment and share the challan (you can also upload it in your CA Desk login).', '', 'Regards,', S.firm || ''].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
    const f = await fileOf(t.clientId, p.work);
    let shared = false;
    if (navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f], text, title: t.title }); shared = true; } catch (e) { if (e.name === 'AbortError') return; } }
    if (!shared) {
      saveBlob(f, f.name);
      if (via === 'wa') window.open(`https://wa.me/${waNum(to)}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      else window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(`${t.title}${t.period ? ' ' + t.period : ''} — payment working`)}&body=${encodeURIComponent(text)}`, '_blank', 'noopener');
      toast(`${f.name} downloaded — attach it in ${via === 'wa' ? 'WhatsApp' : 'Gmail'}`);
    }
    const rec = { at: new Date().toISOString(), via, to };
    await T.patch(t.id, { pay: { ...p, amount, shared: [...(p.shared || []), rec] }, status: 'Waiting on client' }, `Working shared with client on ${via === 'wa' ? 'WhatsApp' : 'email'} for payment`);
    render();
  });

  // challan + paid-on date; used from the task page, the status drop-downs and "Mark paid" on Due dates
  P.challanForm = (tid, filing) => {
    const t = tid && S.tasks.find(x => x.id === tid), p = t?.pay || {};
    S.payCtx = { tid, filing };
    const title = t ? `${t.title}${t.period ? ' — ' + t.period : ''}` : filing.title;
    modal(`<h2>Mark as paid — ${esc(title)}</h2>
      <form data-form="payChallanSave" class="grid">
        <label>Paid on<input type="date" name="paidOn" value="${todayISO()}" required></label>
        <label>Amount paid (₹)<input type="number" min="0" step="0.01" name="amount" value="${p.amount || ''}"></label>
        <label>Challan no. / CIN / CRN<input name="no" placeholder="e.g. 0510308 05112026 12345"></label>
        <label>BSR code (optional)<input name="bsr"></label>
        <label class="span2">Payment challan (PDF or photo)<input type="file" name="file" accept="application/pdf,image/*" ${isAdmin() ? '' : 'required'}></label>
        <p class="muted small span2">${isAdmin() ? 'The challan is saved in the client\'s Documents and the task is closed.' : 'Your CA will see the challan straight away.'}</p>
        <div class="span2 btns"><button class="primary">Mark paid &amp; close</button><button type="button" data-act="closeModal">Cancel</button></div></form>`);
  };
  A.payChallan = ({ tid }) => P.challanForm(tid);

  F.payChallanSave = (fd, form) => guard(async () => {
    let { tid, filing } = S.payCtx || {};
    let t = tid && S.tasks.find(x => x.id === tid);
    if (!t && filing && isAdmin()) { const id = await T.create({ clientId: filing.cid, catId: filing.catId || payCode(filing.key), title: filing.title, period: filing.period, due: filing.due, filingKey: filing.key }); t = S.tasks.find(x => x.id === id); }
    const f = fd.get('file'); const paidOn = fd.get('paidOn'), amount = +fd.get('amount') || 0, no = fd.get('no').trim(), bsr = fd.get('bsr').trim();
    let challan = { paidOn, amount, no, bsr, by: me(), byRole: isAdmin() ? 'ca' : 'client', at: new Date().toISOString() };
    if (f && f.size) challan = { ...challan, ...(await upload(t || { clientId: filing.cid, filingKey: filing.key }, f, 'Payment challan')) };
    if (t) {
      await T.patch(t.id, { pay: { ...(t.pay || {}), challan, amount: amount || t.pay?.amount || 0 }, status: 'Completed', ack: no || t.ack || '',
        done: { ...(t.done || {}), acts: (t.list?.acts || []).map(() => true) } }, `Paid on ${isoToDisp(paidOn)}${amount ? ' · ' + inr(amount) : ''} — challan uploaded by ${challan.by}${challan.byRole === 'client' ? ' (client)' : ''}`);
    }
    const cid = t?.clientId || filing.cid, key = t?.filingKey || filing?.key;
    if (key) {
      const rec = { status: 'filed', paid: true, filedOn: paidOn, paidOn, amount, ack: no, bsr, challanDoc: challan.docId || '', remarks: `Paid${no ? ' · challan ' + no : ''}`, by: S.profile?.email || '', byRole: challan.byRole, at: new Date().toISOString() };
      await setDoc(doc(db, 'clients', cid, 'filings', key), rec);
      S.allFilings[`${cid}|${key}`] = rec; if (S.cid === cid && S.filings) S.filings[key] = rec;
    }
    S.payCtx = null; closeModal(); render();
  }, 'Marked paid — task closed');

  return P;
}
