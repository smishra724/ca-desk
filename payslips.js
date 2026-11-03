// Payslips inside labour-law / payroll tasks: keep the client's employees, build payslips from a salary sheet
// (or upload the payslip PDFs made elsewhere), and share each one with the employee on WhatsApp or email.
// A static site can't send files by itself, so sharing uses the system share sheet where the browser supports
// files (phones, Chrome/Edge on Windows); otherwise the PDF is downloaded and WhatsApp / Gmail opens with the
// message ready for the file to be attached.

const DED = ['PF', 'EPF', 'Employee PF', 'ESIC', 'ESI', 'PT', 'Professional Tax', 'TDS', 'Income Tax', 'LWF', 'Advance', 'Loan', 'Other Deductions', 'Deductions'];
const INFO = ['Emp Code', 'Employee Code', 'Code', 'Name', 'Employee Name', 'Designation', 'Department', 'Mobile', 'Phone', 'Email', 'UAN', 'ESIC No', 'ESIC Number', 'PAN',
  'Bank A/c', 'Bank Account', 'IFSC', 'DOJ', 'Date of Joining', 'Paid Days', 'Days Paid', 'Working Days', 'LOP Days', 'Gross', 'Gross Salary', 'Total Earnings', 'Total Deductions', 'Net', 'Net Pay', 'Net Salary', 'S.No', 'Sr No', 'S No'];
const norm = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const N = v => { const n = +String(v ?? '').replace(/[,₹\s]/g, ''); return isFinite(n) ? n : 0; };
const inr = n => (Math.round(n * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function words(n) { // Indian numbering, rupees only
  n = Math.round(n); if (!n) return 'Zero';
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = x => x < 20 ? a[x] : b[Math.floor(x / 10)] + (x % 10 ? ' ' + a[x % 10] : '');
  const three = x => (x >= 100 ? a[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' : '') : '') + (x % 100 ? two(x % 100) : '');
  const parts = [];
  const cr = Math.floor(n / 1e7); n %= 1e7; const lk = Math.floor(n / 1e5); n %= 1e5; const th = Math.floor(n / 1e3); n %= 1e3;
  if (cr) parts.push(three(cr) + ' Crore'); if (lk) parts.push(two(lk) + ' Lakh'); if (th) parts.push(two(th) + ' Thousand'); if (n) parts.push(three(n));
  return parts.join(' ');
}

export function initPayslips(ctx) {
  const { S, A, C, esc, toast, modal, closeModal, guard, render, isoToDisp, db, fs, saveBlob, busy } = ctx;
  const { doc, getDocs, setDoc, updateDoc, deleteDoc, collection, writeBatch, arrayUnion } = fs;
  const P = {};
  const pkey = p => (p || 'no-period').replace(/[^A-Za-z0-9]+/g, '-');
  const client = () => S.clients.find(c => c.id === S.ps?.cid) || S.client || {};
  const waNum = s => { const d = String(s || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d.replace(/^0+/, ''); };

  P.applies = t => t && t.clientId && (t.deptId === 'payroll' || ['PAYROLL', 'EPF', 'ESIC', 'PT', 'LWF'].includes(t.catId));

  async function load(cid, period) {
    S.ps = { cid, period, loading: true, emps: [], slips: {} };
    const [e, p] = await Promise.all([getDocs(collection(db, 'clients', cid, 'employees')), getDocs(collection(db, 'clients', cid, 'payslips'))]);
    const emps = e.docs.map(d => ({ id: d.id, ...d.data() })).filter(x => !x.left).sort((a, b) => (a.code || '').localeCompare(b.code || '', 'en', { numeric: true }) || (a.name || '').localeCompare(b.name || ''));
    const slips = {}; for (const d of p.docs) { const x = d.data(); if (x.period === period) slips[x.eid] = { id: d.id, ...x }; }
    S.ps = { cid, period, loading: false, emps, slips };
  }

  /* ---------- section on the task page ---------- */
  P.section = t => {
    if (!P.applies(t)) return '';
    const period = t.period || '';
    if (!S.ps || S.ps.cid !== t.clientId || S.ps.period !== period) {
      if (!S.ps?.loading || S.ps.cid !== t.clientId || S.ps.period !== period) load(t.clientId, period).then(render).catch(e => { S.ps = null; toast(e.message); });
      return `<section class="card"><h2>Payslips</h2><p class="muted">Loading employees…</p></section>`;
    }
    const { emps, slips } = S.ps;
    const ready = emps.filter(e => slips[e.id]).length, sent = emps.filter(e => slips[e.id]?.sent?.length).length;
    const total = emps.reduce((s, e) => s + (slips[e.id]?.data?.net || 0), 0);
    return `<section class="card payslips">
      <div class="row-between wrap"><div><h2>Payslips${period ? ` — ${esc(period)}` : ''}</h2>
        <p class="muted small">${emps.length} employee${emps.length === 1 ? '' : 's'} · ${ready} payslip${ready === 1 ? '' : 's'} ready · ${sent} shared${total ? ` · Net pay ₹${inr(total)}` : ''}</p></div>
        <div class="btns">
          <label class="filebtn">Import salary sheet<input type="file" accept=".xlsx,.xls,.csv" data-change="psSheet"></label>
          <label class="filebtn ghostbtn">Upload payslip PDFs<input type="file" accept="application/pdf,image/*" multiple data-change="psFiles"></label>
          <button data-act="psTemplate">Salary sheet template</button>
          <button data-act="psEmp">+ Employee</button>
          ${ready ? `<button class="primary wa" data-act="psShareAll">Share all payslips</button>` : ''}
        </div></div>
      ${period ? '' : '<p class="warn">Set the task\'s Period (e.g. Oct 2026) so payslips are filed under the right month.</p>'}
      ${emps.length ? `<div class="reg-wrap ps-wrap"><table class="reg"><thead><tr><th>Code</th><th>Employee</th><th>Contact</th><th class="num">Paid days</th><th class="num">Gross</th><th class="num">Deductions</th><th class="num">Net pay</th><th>Payslip</th><th>Share</th></tr></thead><tbody>
        ${emps.map(e => { const s = slips[e.id], d = s?.data, last = s?.sent?.[s.sent.length - 1]; return `<tr>
          <td class="mono nowrap">${esc(e.code || '—')}</td>
          <td><a href="#" class="cl" data-act="psEmp" data-id="${e.id}">${esc(e.name)}</a><div class="sub">${esc(e.designation || '')}</div></td>
          <td class="small">${esc(e.mobile || '')}${e.email ? `<div class="sub">${esc(e.email)}</div>` : ''}${!e.mobile && !e.email ? '<span class="muted">Add mobile / email</span>' : ''}</td>
          <td class="num">${d?.days ?? '—'}</td><td class="num">${d ? inr(d.gross) : '—'}</td><td class="num">${d ? inr(d.ded) : '—'}</td><td class="num"><b>${d ? inr(d.net) : '—'}</b></td>
          <td class="nowrap">${s ? `<button class="sm" data-act="psView" data-id="${e.id}">${s.file ? 'PDF' : 'View'}</button> <span class="tag green">Ready</span>` : '<span class="tag">Missing</span>'}</td>
          <td class="nowrap">${s ? `<span class="rbtns"><button class="rb wa ${e.mobile ? '' : 'off'}" data-act="psSend" data-id="${e.id}" data-via="wa" title="WhatsApp">${ctx.WA_ICON}</button><button class="rb em ${e.email ? '' : 'off'}" data-act="psSend" data-id="${e.id}" data-via="mail" title="Email">${ctx.MAIL_ICON}</button></span>${last ? `<span class="rlast">Sent ${isoToDisp(last.at.slice(0, 10))} · ${last.via === 'wa' ? 'WhatsApp' : 'Email'}</span>` : ''}` : ''}</td></tr>`; }).join('')}
      </tbody></table></div>` : `<div class="empty-state small">No employees yet. Import a salary sheet (employees are added from it) or add them one by one.</div>`}
    </section>`;
  };

  /* ---------- employees ---------- */
  A.psEmp = ({ id }) => {
    const e = S.ps.emps.find(x => x.id === id) || {};
    modal(`<h2>${id ? 'Edit' : 'Add'} employee — ${esc(client().name || '')}</h2><form data-form="psEmpSave" data-id="${id || ''}" class="grid">
      <label>Employee code<input name="code" value="${esc(e.code || '')}"></label><label>Name<input name="name" value="${esc(e.name || '')}" required></label>
      <label>Designation<input name="designation" value="${esc(e.designation || '')}"></label><label>Date of joining<input type="date" name="doj" value="${esc(e.doj || '')}"></label>
      <label>WhatsApp mobile<input name="mobile" value="${esc(e.mobile || '')}"></label><label>Email<input type="email" name="email" value="${esc(e.email || '')}"></label>
      <label>UAN<input name="uan" value="${esc(e.uan || '')}"></label><label>ESIC no.<input name="esic" value="${esc(e.esic || '')}"></label>
      <label>PAN<input name="pan" class="mono up" value="${esc(e.pan || '')}"></label><label>Bank account<input name="bank" value="${esc(e.bank || '')}"></label>
      <div class="span2 btns"><button class="primary">Save</button>${id ? '<button type="button" class="danger" data-act="psEmpLeft" data-id="' + id + '">Mark as left</button>' : ''}<button type="button" data-act="closeModal">Cancel</button></div></form>`);
  };
  ctx.F.psEmpSave = (fd, form) => guard(async () => {
    const data = Object.fromEntries(['code', 'name', 'designation', 'doj', 'mobile', 'email', 'uan', 'esic', 'pan', 'bank'].map(k => [k, (fd.get(k) || '').trim()]));
    data.pan = data.pan.toUpperCase();
    const id = form.dataset.id, ref = id ? doc(db, 'clients', S.ps.cid, 'employees', id) : doc(collection(db, 'clients', S.ps.cid, 'employees'));
    await setDoc(ref, data, { merge: true }); await load(S.ps.cid, S.ps.period); closeModal(); render();
  }, 'Employee saved');
  A.psEmpLeft = ({ id }) => guard(async () => { await updateDoc(doc(db, 'clients', S.ps.cid, 'employees', id), { left: true }); await load(S.ps.cid, S.ps.period); closeModal(); render(); }, 'Marked as left');

  /* ---------- salary sheet → payslips ---------- */
  A.psTemplate = () => {
    const ws = XLSX.utils.aoa_to_sheet([['Emp Code', 'Name', 'Designation', 'Mobile', 'Email', 'UAN', 'ESIC No', 'Paid Days', 'Basic', 'HRA', 'Conveyance', 'Special Allowance', 'Other Earnings', 'PF', 'ESIC', 'PT', 'TDS', 'Advance', 'Other Deductions'],
      ['E001', 'Ramesh Kumar', 'Accountant', '9876543210', 'ramesh@example.com', '100123456789', '', 30, 15000, 6000, 1600, 2400, 0, 1800, 0, 200, 0, 0, 0]]);
    ws['!cols'] = [{ wch: 9 }, { wch: 22 }, { wch: 16 }, { wch: 12 }, { wch: 24 }, { wch: 14 }, { wch: 12 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Salary'); XLSX.writeFile(wb, 'Salary-sheet-template.xlsx');
  };
  C.psSheet = el => {
    const f = el.files[0]; if (!f) return; el.value = '';
    guard(async () => {
      const wb = XLSX.read(await f.arrayBuffer()); const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
      const hi = rows.findIndex(r => r.some(c => /name/i.test(c)) && r.some(c => /basic|gross|net/i.test(c)));
      if (hi < 0) throw new Error('Could not find the header row — it needs a Name column and Basic / Gross / Net columns. Use the template.');
      const H = rows[hi].map(h => String(h).trim()), idx = n => H.findIndex(h => n.some(x => norm(h) === norm(x)));
      const I = { code: idx(['Emp Code', 'Employee Code', 'Code']), name: idx(['Name', 'Employee Name']), desig: idx(['Designation']), mobile: idx(['Mobile', 'Phone']), email: idx(['Email']),
        uan: idx(['UAN']), esic: idx(['ESIC No', 'ESIC Number']), days: idx(['Paid Days', 'Days Paid', 'Working Days']), gross: idx(['Gross', 'Gross Salary', 'Total Earnings']),
        tded: idx(['Total Deductions']), net: idx(['Net', 'Net Pay', 'Net Salary']) };
      const info = new Set(INFO.map(norm)), dedSet = new Set(DED.map(norm));
      const earnCols = H.map((h, i) => [h, i]).filter(([h]) => h && !info.has(norm(h)) && !dedSet.has(norm(h)));
      const dedCols = H.map((h, i) => [h, i]).filter(([h]) => h && dedSet.has(norm(h)));
      const emps = [...S.ps.emps]; let made = 0, added = 0;
      let b = writeBatch(db), ops = 0;
      for (const r of rows.slice(hi + 1)) {
        const name = String(r[I.name] || '').trim(); if (!name || /^total/i.test(name)) continue;
        const code = I.code >= 0 ? String(r[I.code] || '').trim() : '';
        let e = emps.find(x => (code && x.code === code) || norm(x.name) === norm(name));
        const info = { code, name, designation: I.desig >= 0 ? String(r[I.desig] || '').trim() : '', mobile: I.mobile >= 0 ? String(r[I.mobile] || '').trim() : '',
          email: I.email >= 0 ? String(r[I.email] || '').trim() : '', uan: I.uan >= 0 ? String(r[I.uan] || '').trim() : '', esic: I.esic >= 0 ? String(r[I.esic] || '').trim() : '' };
        const ref = e ? doc(db, 'clients', S.ps.cid, 'employees', e.id) : doc(collection(db, 'clients', S.ps.cid, 'employees'));
        if (!e) { e = { id: ref.id }; emps.push(e); added++; }
        const upd = Object.fromEntries(Object.entries(info).filter(([k, v]) => v && !e[k]));
        if (Object.keys(upd).length || !e.name) { b.set(ref, { ...upd, name: e.name || name }, { merge: true }); ops++; Object.assign(e, upd); }
        const earnings = earnCols.map(([h, i]) => [h, N(r[i])]).filter(([, v]) => v);
        const deductions = dedCols.map(([h, i]) => [h, N(r[i])]).filter(([, v]) => v);
        const gross = I.gross >= 0 && N(r[I.gross]) ? N(r[I.gross]) : earnings.reduce((s, x) => s + x[1], 0);
        const ded = I.tded >= 0 && N(r[I.tded]) ? N(r[I.tded]) : deductions.reduce((s, x) => s + x[1], 0);
        const net = I.net >= 0 && N(r[I.net]) ? N(r[I.net]) : gross - ded;
        const old = S.ps.slips[e.id];
        b.set(doc(db, 'clients', S.ps.cid, 'payslips', `${pkey(S.ps.period)}_${e.id}`), { eid: e.id, period: S.ps.period, src: 'sheet',
          data: { days: I.days >= 0 ? N(r[I.days]) : '', earnings, deductions, gross, ded, net }, sent: old?.sent || [], at: new Date().toISOString() });
        made++; if (++ops >= 400) { await b.commit(); b = writeBatch(db); ops = 0; }
      }
      await b.commit(); await load(S.ps.cid, S.ps.period); render();
      toast(`${made} payslip(s) prepared${added ? `, ${added} new employee(s) added` : ''}`);
    });
  };

  /* ---------- upload ready-made payslip PDFs ---------- */
  C.psFiles = el => {
    const files = [...el.files]; el.value = ''; if (!files.length) return;
    guard(async () => {
      let ok = 0; const miss = [];
      for (const f of files) {
        const fn = norm(f.name.replace(/\.[^.]+$/, ''));
        const e = S.ps.emps.find(x => x.code && fn.includes(norm(x.code))) || S.ps.emps.find(x => x.name && fn.includes(norm(x.name)))
          || S.ps.emps.find(x => x.name && norm(x.name).split(/(?=[a-z])/).length && x.name.split(/\s+/).every(w => fn.includes(norm(w))));
        if (!e) { miss.push(f.name); continue; }
        if (f.size > 3 * 1024 * 1024) { miss.push(`${f.name} (over 3 MB)`); continue; }
        busy(true, `Uploading ${f.name}…`);
        const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
        const id = `${pkey(S.ps.period)}_${e.id}`, n = Math.ceil(b64.length / 700000);
        for (let i = 0; i < n; i++) await setDoc(doc(db, 'clients', S.ps.cid, 'payslips', id, 'chunks', String(i).padStart(4, '0')), { d: b64.slice(i * 700000, (i + 1) * 700000) });
        const old = S.ps.slips[e.id];
        await setDoc(doc(db, 'clients', S.ps.cid, 'payslips', id), { eid: e.id, period: S.ps.period, src: 'file', data: old?.data || null,
          file: { name: f.name, mime: f.type || 'application/pdf', size: f.size, chunks: n }, sent: old?.sent || [], at: new Date().toISOString() });
        ok++;
      }
      busy(false); await load(S.ps.cid, S.ps.period); render();
      if (miss.length) modal(`<h2>${ok} payslip(s) attached</h2><p>These files didn't match an employee code or name. Rename them to include the code (e.g. <code>E001.pdf</code>) or add the employee first:</p><ul class="small">${miss.map(m => `<li>${esc(m)}</li>`).join('')}</ul><div class="btns"><button data-act="closeModal">OK</button></div>`);
      else toast(`${ok} payslip(s) attached`);
    });
  };

  /* ---------- PDF ---------- */
  async function pdfFor(e) {
    const s = S.ps.slips[e.id], safe = `Payslip-${(S.ps.period || '').replace(/\s+/g, '-')}-${(e.name || '').replace(/[^\w]+/g, '-')}`;
    if (s.file) {
      const ch = await getDocs(collection(db, 'clients', S.ps.cid, 'payslips', s.id, 'chunks'));
      const b64 = ch.docs.sort((a, b) => a.id.localeCompare(b.id)).map(d => d.data().d).join('');
      const u8 = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      return new File([u8], s.file.name.endsWith('.pdf') ? `${safe}.pdf` : s.file.name, { type: s.file.mime });
    }
    const { jsPDF } = window.jspdf; const c = client(), d = s.data, pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    const W = pdf.internal.pageSize.getWidth(), M = 40; let y = 48;
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(15); pdf.text(c.name || '', W / 2, y, { align: 'center' }); y += 15;
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
    if (c.address) { for (const l of pdf.splitTextToSize(c.address.replace(/\n/g, ', '), W - 2 * M)) { pdf.text(l, W / 2, y, { align: 'center' }); y += 11; } }
    y += 6; pdf.setFillColor(21, 35, 63); pdf.rect(M, y, W - 2 * M, 22, 'F'); pdf.setTextColor(255); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
    pdf.text(`Payslip for ${S.ps.period}`, W / 2, y + 15, { align: 'center' }); pdf.setTextColor(0); y += 36;
    const info = [['Employee name', e.name], ['Employee code', e.code], ['Designation', e.designation], ['Date of joining', e.doj ? isoToDisp(e.doj) : ''], ['UAN', e.uan], ['ESIC no.', e.esic], ['PAN', e.pan], ['Bank account', e.bank], ['Paid days', d.days === '' ? '' : String(d.days)]].filter(x => x[1]);
    pdf.setFontSize(9.5);
    info.forEach(([k, v], i) => { const col = i % 2, x = M + col * (W - 2 * M) / 2, yy = y + Math.floor(i / 2) * 15; pdf.setFont('helvetica', 'normal'); pdf.setTextColor(95); pdf.text(k, x, yy); pdf.setTextColor(0); pdf.setFont('helvetica', 'bold'); pdf.text(String(v), x + 95, yy); });
    y += Math.ceil(info.length / 2) * 15 + 12;
    const half = (W - 2 * M) / 2, rows = Math.max(d.earnings.length, d.deductions.length, 1);
    pdf.setFillColor(238, 241, 246); pdf.rect(M, y, W - 2 * M, 20, 'F'); pdf.setFont('helvetica', 'bold');
    pdf.text('Earnings', M + 8, y + 13); pdf.text('Amount (Rs.)', M + half - 8, y + 13, { align: 'right' });
    pdf.text('Deductions', M + half + 8, y + 13); pdf.text('Amount (Rs.)', W - M - 8, y + 13, { align: 'right' }); y += 20;
    pdf.setFont('helvetica', 'normal');
    for (let i = 0; i < rows; i++) {
      const er = d.earnings[i], dr = d.deductions[i];
      if (er) { pdf.text(String(er[0]), M + 8, y + 14); pdf.text(inr(er[1]), M + half - 8, y + 14, { align: 'right' }); }
      if (dr) { pdf.text(String(dr[0]), M + half + 8, y + 14); pdf.text(inr(dr[1]), W - M - 8, y + 14, { align: 'right' }); }
      y += 18;
    }
    pdf.setDrawColor(210); pdf.line(M, y + 4, W - M, y + 4); pdf.setFont('helvetica', 'bold');
    pdf.text('Gross earnings', M + 8, y + 18); pdf.text(inr(d.gross), M + half - 8, y + 18, { align: 'right' });
    pdf.text('Total deductions', M + half + 8, y + 18); pdf.text(inr(d.ded), W - M - 8, y + 18, { align: 'right' }); y += 34;
    pdf.setFillColor(227, 242, 236); pdf.rect(M, y, W - 2 * M, 34, 'F'); pdf.setFontSize(12);
    pdf.text(`Net pay: Rs. ${inr(d.net)}`, M + 10, y + 15); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
    pdf.text(`(Rupees ${words(d.net)} only)`, M + 10, y + 28); y += 56;
    pdf.setTextColor(120); pdf.setFontSize(8.5); pdf.text('This is a computer-generated payslip and does not need a signature.', W / 2, y, { align: 'center' });
    return new File([pdf.output('blob')], `${safe}.pdf`, { type: 'application/pdf' });
  }
  A.psView = ({ id }) => guard(async () => { const e = S.ps.emps.find(x => x.id === id); const f = await pdfFor(e); window.open(URL.createObjectURL(f), '_blank'); });

  /* ---------- share ---------- */
  const msg = e => `Dear ${e.name},\n\nPlease find attached your payslip for ${S.ps.period}.\n\nRegards,\n${client().name || ''}`;
  async function send(e, via, quiet) {
    const f = await pdfFor(e), text = msg(e);
    if (via === 'wa' && !e.mobile) throw new Error(`Add ${e.name}'s mobile number first.`);
    if (via === 'mail' && !e.email) throw new Error(`Add ${e.name}'s email first.`);
    let shared = false;
    if (navigator.canShare?.({ files: [f] })) {
      try { await navigator.share({ files: [f], text, title: `Payslip ${S.ps.period}` }); shared = true; } catch (err) { if (err.name === 'AbortError') return false; }
    }
    if (!shared) {
      saveBlob(f, f.name);
      if (via === 'wa') window.open(`https://wa.me/${waNum(e.mobile)}?text=${encodeURIComponent(text + '\n\n(payslip attached)')}`, '_blank', 'noopener');
      else window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(e.email)}&su=${encodeURIComponent(`Payslip for ${S.ps.period} — ${client().name || ''}`)}&body=${encodeURIComponent(text)}`, '_blank', 'noopener');
      if (!quiet) toast(`${f.name} downloaded — attach it in ${via === 'wa' ? 'WhatsApp' : 'Gmail'}`);
    }
    const s = S.ps.slips[e.id], rec = { at: new Date().toISOString(), via, to: via === 'wa' ? e.mobile : e.email };
    await updateDoc(doc(db, 'clients', S.ps.cid, 'payslips', s.id), { sent: arrayUnion(rec) }); s.sent = [...(s.sent || []), rec];
    return true;
  }
  A.psSend = ({ id, via }) => guard(async () => { if (await send(S.ps.emps.find(x => x.id === id), via)) render(); });
  A.psShareAll = () => {
    const list = S.ps.emps.filter(e => S.ps.slips[e.id]);
    modal(`<h2>Share payslips — ${esc(S.ps.period)}</h2>
      <p class="muted small">Each button shares that employee's payslip PDF. Where the browser can't attach files, the PDF downloads and WhatsApp / Gmail opens with the message ready — attach the file and send. Rows turn green once shared.</p>
      <div class="bulkrem">${list.map(e => `<div class="br-row ${S.ps.slips[e.id].sent?.length ? 'sent' : ''}" id="ps_${e.id}"><span><b>${esc(e.name)}</b><small>${esc(e.mobile || 'no mobile')} · ${esc(e.email || 'no email')} · Net ₹${inr(S.ps.slips[e.id].data?.net || 0)}</small></span>
        <span class="rbtns"><button class="rb wa ${e.mobile ? '' : 'off'}" data-act="psSendRow" data-id="${e.id}" data-via="wa">${ctx.WA_ICON}</button><button class="rb em ${e.email ? '' : 'off'}" data-act="psSendRow" data-id="${e.id}" data-via="mail">${ctx.MAIL_ICON}</button></span></div>`).join('')}</div>
      <div class="btns mt"><button data-act="psDone">Done</button></div>`);
  };
  A.psSendRow = ({ id, via }) => guard(async () => { if (await send(S.ps.emps.find(x => x.id === id), via, true)) document.getElementById('ps_' + id)?.classList.add('sent'); });
  A.psDone = () => { closeModal(); render(); };

  P.reset = () => { S.ps = null; };
  return P;
}
