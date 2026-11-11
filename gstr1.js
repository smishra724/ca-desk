// File GSTR-1 / IFF: the same three steps as the GST portal's offline route.
// 1. Browse the JSON (from the GST Offline Tool or accounting software) — checked for GSTIN, period and common errors.
// 2. Upload it on the GST portal (opens the portal with the client's login) and file with DSC/EVC there.
// 3. Drop the filed GSTR-1 PDF — the ARN and its date are read from it, the PDF is saved and the return is marked filed.
// The portal has no public upload API for CAs; direct upload needs a GSP (GST Suvidha Provider) account.

const SEC = {
  b2b: '4A, 4B — B2B invoices', b2ba: '9A — Amended B2B', b2cl: '5 — B2C (large)', b2cla: '9A — Amended B2C (large)',
  exp: '6A — Exports', expa: '9A — Amended exports', b2cs: '7 — B2C (others)', b2csa: '10 — Amended B2C (others)',
  nil: '8 — Nil rated / exempt / non-GST', at: '11A — Advances received', ata: '11A — Amended advances', txpd: '11B — Advances adjusted', txpda: '11B — Amended advance adjustment',
  cdnr: '9B — Credit / debit notes (registered)', cdnra: '9C — Amended CDN (registered)', cdnur: '9B — Credit / debit notes (unregistered)', cdnura: '9C — Amended CDN (unregistered)',
  hsn: '12 — HSN summary', doc_issue: '13 — Documents issued', supeco: '14 — Supplies through e-commerce', supecoa: '14A — Amended e-commerce supplies',
  ecom: '15 — E-commerce supplies', ecoma: '15A — Amended e-commerce supplies',
};
const IFF_OK = new Set(['b2b', 'b2ba', 'cdnr', 'cdnra', 'ecom', 'ecoma']);
const META = new Set(['gstin', 'fp', 'gt', 'cur_gt', 'version', 'hash', 'filing_typ', 'fil_dt']);
const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const n = v => +v || 0;
const z = () => ({ recs: 0, val: 0, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
function addTax(a, x, sign = 1) {
  a.txval += sign * n(x.txval ?? x.ad_amt ?? x.adamt); a.iamt += sign * n(x.iamt); a.camt += sign * n(x.camt); a.samt += sign * n(x.samt); a.csamt += sign * n(x.csamt);
}
const itms = inv => (inv.itms || []).map(i => i.itm_det || i);

// Totals per section + checks. key/gstin come from the due row this JSON is meant for.
export function checkJson(j, { gstin, fp, iff, noHsnCheck }) {
  const errs = [], warns = [], rows = [];
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { errs: ['This is not a GSTR-1 JSON file.'], warns, rows };
  if (!j.gstin) errs.push('The file has no GSTIN — it does not look like a GSTR-1 / IFF JSON.');
  else if (j.gstin.toUpperCase() !== gstin) errs.push(`GSTIN in the file is ${j.gstin}, but this return is for ${gstin}.`);
  if (!j.fp) warns.push('The file has no return period (fp).');
  else if (String(j.fp) !== fp) errs.push(`Return period in the file is ${fpLabel(j.fp)}, but this return is for ${fpLabel(fp)}.`);
  const pEnd = new Date(+fp.slice(2), +fp.slice(0, 2), 0);
  const seen = new Map(); let invTx = 0, hsnTx = null;
  const inv = (sec, x, who) => {
    const no = String(x.inum || x.nt_num || '').trim();
    if (no) {
      const k = no.toUpperCase(); if (seen.has(k)) warns.push(`Document ${no} appears twice (${seen.get(k)} and ${who}).`); else seen.set(k, who);
      if (no.length > 16) errs.push(`Document number ${no} is longer than 16 characters.`);
    }
    const dt = x.idt || x.nt_dt; if (dt && /^\d{2}-\d{2}-\d{4}$/.test(dt)) { const d = new Date(+dt.slice(6), +dt.slice(3, 5) - 1, +dt.slice(0, 2)); if (d > pEnd) errs.push(`${no || 'A document'} is dated ${dt}, after the end of the return period.`); }
  };
  for (const [k, v] of Object.entries(j)) {
    if (META.has(k)) continue;
    const a = z();
    if (['b2b', 'b2ba', 'cdnr', 'cdnra'].includes(k)) {
      for (const p of v || []) {
        if (p.ctin && !GSTIN_RE.test(p.ctin)) errs.push(`Buyer GSTIN ${p.ctin} is not a valid GSTIN.`);
        if (p.ctin && p.ctin === gstin) errs.push(`Buyer GSTIN ${p.ctin} is your own GSTIN.`);
        for (const x of (p.inv || p.nt || [])) {
          const sign = x.ntty === 'C' ? -1 : 1; a.recs++; a.val += sign * n(x.val); inv(k, x, `${k.toUpperCase()} ${p.ctin || ''}`.trim());
          for (const i of itms(x)) addTax(a, i, sign);
        }
      }
    } else if (['b2cl', 'b2cla', 'exp', 'expa'].includes(k)) {
      for (const p of v || []) for (const x of p.inv || []) { a.recs++; a.val += n(x.val); inv(k, x, k.toUpperCase()); for (const i of itms(x)) addTax(a, i); }
    } else if (['cdnur', 'cdnura'].includes(k)) {
      for (const x of v || []) { const sign = x.ntty === 'C' ? -1 : 1; a.recs++; a.val += sign * n(x.val); inv(k, x, k.toUpperCase()); for (const i of itms(x)) addTax(a, i, sign); }
    } else if (['b2cs', 'b2csa'].includes(k)) {
      for (const x of v || []) { a.recs++; for (const i of x.itms ? itms(x) : [x]) addTax(a, i); }
    } else if (['at', 'ata', 'txpd', 'txpda'].includes(k)) {
      for (const x of v || []) { a.recs++; for (const i of itms(x)) addTax(a, i); }
    } else if (k === 'nil') {
      for (const x of v?.inv || []) { a.recs++; a.txval += n(x.nil_amt) + n(x.expt_amt) + n(x.ngsup_amt); }
    } else if (k === 'hsn') {
      const list = [...(v?.data || []), ...(v?.hsn_b2b || []), ...(v?.hsn_b2c || [])];
      for (const x of list) { a.recs++; a.val += n(x.val); addTax(a, x); if (!x.hsn_sc) errs.push('An HSN summary line has no HSN code.'); }
      hsnTx = a.txval;
    } else if (k === 'doc_issue') {
      for (const d of v?.doc_det || []) for (const x of d.docs || []) { a.recs++; a.val += n(x.net_issue); }
    } else if (Array.isArray(v)) { a.recs = v.length; }
    else continue;
    if (['b2b', 'b2cl', 'exp', 'b2cs', 'cdnr', 'cdnur'].includes(k)) invTx += a.txval;
    if (iff && !IFF_OK.has(k) && a.recs) errs.push(`${SEC[k] || k} is not allowed in IFF — only B2B invoices and credit/debit notes can be filed in IFF.`);
    rows.push({ k, label: SEC[k] || k, ...a });
  }
  if (!rows.some(r => r.recs)) warns.push('The file has no invoices. For a nil return, use “File Nil GSTR-1” on the portal instead of uploading a JSON.');
  if (!iff && !noHsnCheck && hsnTx !== null && Math.abs(hsnTx - invTx) > 1) warns.push(`HSN summary taxable value (₹${inr(hsnTx)}) does not match invoices and notes (₹${inr(invTx)}). Difference ₹${inr(hsnTx - invTx)}.`);
  if (!iff && invTx > 0 && hsnTx === null) warns.push('There is no HSN summary (Table 12). It is mandatory in GSTR-1.');
  return { errs: [...new Set(errs)].slice(0, 25), warns: [...new Set(warns)].slice(0, 25), rows };
}
export const fpLabel = fp => { const s = String(fp); return /^\d{6}$/.test(s) ? `${MONTHS[+s.slice(0, 2) - 1] || s.slice(0, 2)} ${s.slice(2)}` : s; };
const inr = v => (Math.round(v * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ARN and its date from the filed GSTR-1 / IFF PDF (or the acknowledgement e-mail / SMS text)
export function readArn(text, gstin) {
  const t = String(text || '').replace(/ /g, ' ');
  const arn = (t.match(/ARN[^A-Z0-9]{0,40}(AA[0-9]{6}[0-9A-Z]{7})\b/i) || t.match(/\b(AA[0-9]{6}[0-9A-Z]{7})\b/) || [])[1] || '';
  let date = '';
  const dm = t.match(/Date\s+of\s+ARN[^0-9]{0,20}(\d{2})[\/.-](\d{2})[\/.-](\d{4})/i) || t.match(/filed[^0-9]{0,60}(\d{2})[\/.-](\d{2})[\/.-](\d{4})/i);
  if (dm) date = `${dm[3]}-${dm[2]}-${dm[1]}`;
  const gs = [...new Set((t.toUpperCase().match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/g) || []))];
  const wrongGstin = gstin && gs.length && !gs.includes(gstin) ? gs[0] : '';
  return { arn: arn.toUpperCase(), date, wrongGstin };
}

import { tallyCompanies, fetchGstr1, gstr1FromXml, readTallyFile } from './tally.js';

export function initGstr1(ctx) {
  const { S, A, C, esc, toast, modal, closeModal, guard, render, todayISO, isoToDisp, db, saveFile, saveBlob, T, busy, extractText, portalLogin, fs } = ctx;
  const { doc, setDoc, getDocs, collection } = fs;
  const G = {};
  G.applies = key => /^(GSTR1|IFF)-/.test(key);
  G.button = r => G.applies(r.key) ? `<button class="sm g1btn" data-act="g1Open" data-cid="${r.c.id}" data-key="${esc(r.key)}" data-alt="${esc(r.altKey || '')}" data-form="${esc(r.form)}" data-period="${esc(r.period)}" data-due="${ctx.isoLocalD(r.due)}" title="File ${/^IFF/.test(r.key) ? 'IFF' : 'GSTR-1'}: upload JSON, file on the portal, save the ARN and PDF">${ICON} File</button>` : '';
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 18v-6M9 15l3-3 3 3"/></svg>';

  const fpOf = key => { const m = key.match(/-(\d{4})-(\d{2})/); return m ? m[2] + m[1] : ''; };
  const gstinOf = key => key.split('@')[1] || S.clients.find(c => c.id === S.g1?.cid)?.gstin || '';

  A.g1Open = d => guard(async () => {
    const c = S.clients.find(x => x.id === d.cid) || {};
    const t = T.taskFor(d.cid, d.key, d.alt);
    S.g1 = { ...d, gstin: gstinOf(d.key), fp: fpOf(d.key), iff: /^IFF/.test(d.key), quarterly: /QRMP/.test(d.form), name: ctx.dispName(c), json: null, pdf: null, step: t?.g1?.uploaded ? 3 : t?.g1?.jsonDoc ? 2 : 1, src: lsGet('g1src') || 'tally' };
    S.g1.b2bFrom = S.g1.quarterly ? iffCovered(S.g1) : '';
    draw();
  });
  const g = () => S.g1, task = () => T.taskFor(g().cid, g().key, g().alt);
  const ret = () => g().iff ? 'IFF' : 'GSTR-1';

  function draw() {
    const s = g(), t = task(), p = t?.g1 || {};
    const step = (i, label, done) => `<button class="g1-step ${s.step === i ? 'on' : ''} ${done ? 'done' : ''}" data-act="g1Step" data-i="${i}"><span>${done ? '✓' : i}</span>${label}</button>`;
    modal(`<div class="g1">
      <h2>File ${ret()} — ${esc(s.name)}</h2>
      <p class="muted small"><span class="mono">${esc(s.gstin)}</span> · ${esc(fpLabel(s.fp))}${s.iff ? '' : ''} · due ${isoToDisp(s.due)}</p>
      <div class="g1-steps">${step(1, 'Upload JSON', !!p.jsonDoc)}${step(2, 'File on GST portal', !!p.uploaded)}${step(3, 'Save ARN & PDF', false)}</div>
      <div class="g1-body">${[s1, s2, s3][s.step - 1](s, p)}</div></div>`);
  }

  // Line-level breakup of each GSTR-1 table, from the JSON
  const NTTY = { C: 'Credit note', D: 'Debit note' };
  const SPLY = { INTRB2B: 'Inter-state to registered', INTRAB2B: 'Intra-state to registered', INTRB2C: 'Inter-state to unregistered', INTRAB2C: 'Intra-state to unregistered' };
  const stN = c => c ? `${c}-${ctx.STATE_CODES?.[c] || ''}`.replace(/-$/, '') : '';
  const TAX = ['Taxable', 'IGST', 'CGST', 'SGST', 'Cess'];
  const tx = d => [d.txval, d.iamt, d.camt, d.samt, d.csamt].map(v => +v || 0);
  function breakup(k, j, names = {}) {
    const v = j?.[k]; if (!v) return null;
    const pn = c => names[c] || '';
    const items = x => (x.itms || []).map(i => i.itm_det || i);
    if (['b2b', 'b2ba'].includes(k)) return { cols: ['Buyer GSTIN', 'Party', 'Invoice no.', 'Date', 'Invoice value', 'POS', 'Rate %', ...TAX],
      rows: v.flatMap(p => (p.inv || []).flatMap(x => items(x).map(d => [p.ctin, pn(p.ctin), x.inum, x.idt, +x.val, stN(x.pos), d.rt, ...tx(d)]))) };
    if (['cdnr', 'cdnra'].includes(k)) return { cols: ['Buyer GSTIN', 'Party', 'Type', 'Note no.', 'Date', 'Note value', 'POS', 'Rate %', ...TAX],
      rows: v.flatMap(p => (p.nt || []).flatMap(x => items(x).map(d => [p.ctin, pn(p.ctin), NTTY[x.ntty] || x.ntty, x.nt_num, x.nt_dt, +x.val, stN(x.pos), d.rt, ...tx(d)]))) };
    if (['b2cl', 'b2cla'].includes(k)) return { cols: ['POS', 'Invoice no.', 'Date', 'Invoice value', 'Rate %', ...TAX],
      rows: v.flatMap(p => (p.inv || []).flatMap(x => items(x).map(d => [stN(p.pos), x.inum, x.idt, +x.val, d.rt, ...tx(d)]))) };
    if (['exp', 'expa'].includes(k)) return { cols: ['Type', 'Invoice no.', 'Date', 'Invoice value', 'Port', 'Shipping bill', 'Rate %', ...TAX],
      rows: v.flatMap(p => (p.inv || []).flatMap(x => items(x).map(d => [p.exp_typ, x.inum, x.idt, +x.val, x.sbpcode || '', x.sbnum || '', d.rt, ...tx(d)]))) };
    if (['cdnur', 'cdnura'].includes(k)) return { cols: ['Type', 'Note no.', 'Date', 'Note value', 'Against', 'POS', 'Rate %', ...TAX],
      rows: v.flatMap(x => items(x).map(d => [NTTY[x.ntty] || x.ntty, x.nt_num, x.nt_dt, +x.val, x.typ, stN(x.pos), d.rt, ...tx(d)])) };
    if (['b2cs', 'b2csa'].includes(k)) return { cols: ['Supply', 'POS', 'Rate %', ...TAX],
      rows: v.flatMap(x => (x.itms ? items(x) : [x]).map(d => [x.sply_ty === 'INTER' ? 'Inter-state' : 'Intra-state', stN(x.pos), d.rt ?? x.rt, ...tx(d)])) };
    if (['at', 'ata', 'txpd', 'txpda'].includes(k)) return { cols: ['POS', 'Supply', 'Rate %', 'Advance', 'IGST', 'CGST', 'SGST', 'Cess'],
      rows: v.flatMap(x => items(x).map(d => [stN(x.pos), x.sply_ty === 'INTER' ? 'Inter-state' : 'Intra-state', d.rt, +(d.ad_amt ?? d.adamt) || 0, ...tx(d).slice(1)])) };
    if (k === 'nil') return { cols: ['Supply', 'Nil rated', 'Exempted', 'Non-GST'], rows: (v.inv || []).map(x => [SPLY[x.sply_ty] || x.sply_ty, +x.nil_amt || 0, +x.expt_amt || 0, +x.ngsup_amt || 0]) };
    if (k === 'hsn') return { cols: ['Section', 'HSN/SAC', 'Description', 'UQC', 'Qty', 'Rate %', ...TAX],
      rows: [['', v.data], ['B2B', v.hsn_b2b], ['B2C', v.hsn_b2c]].flatMap(([sec, l]) => (l || []).map(x => [sec, x.hsn_sc, x.desc || '', x.uqc || '', +x.qty || 0, x.rt ?? '', ...tx(x)])) };
    if (k === 'doc_issue') return { cols: ['Document', 'From', 'To', 'Total', 'Cancelled', 'Net issued'],
      rows: (v.doc_det || []).flatMap(dd => (dd.docs || []).map(x => [dd.doc_typ || `Type ${dd.doc_num}`, x.from, x.to, +x.totnum || 0, +x.cancel || 0, +x.net_issue || 0])) };
    return null;
  }
  const NUMCOL = c => /value|Taxable|IGST|CGST|SGST|Cess|Advance|Nil|Exempt|Non-GST|Qty|Rate|Total|Cancelled|Net/.test(c);
  function brkTable(b) {
    const tot = b.cols.map((c, i) => NUMCOL(c) && !/Rate|value/.test(c) ? b.rows.reduce((s, r) => s + (+r[i] || 0), 0) : null);
    return `<div class="g1-brk"><table><thead><tr>${b.cols.map(c => `<th class="${NUMCOL(c) ? 'r' : ''}">${c}</th>`).join('')}</tr></thead><tbody>
      ${b.rows.map(r => `<tr>${r.map((x, i) => `<td class="${NUMCOL(b.cols[i]) ? 'r' : ''} ${/GSTIN/.test(b.cols[i]) ? 'mono' : ''}">${typeof x === 'number' ? (/Rate|Qty|Total|Cancelled|Net issued/.test(b.cols[i]) ? x : inr(x)) : esc(x ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>
      ${b.rows.length > 1 && tot.some(t => t !== null) ? `<tfoot><tr>${tot.map((t, i) => `<td class="${i ? 'r' : ''}">${i === 0 ? '<b>Total</b>' : t === null ? '' : `<b>${/Total|Cancelled|Net issued|Qty/.test(b.cols[i]) ? Math.round(t * 1000) / 1000 : inr(t)}</b>`}</td>`).join('')}</tr></tfoot>` : ''}</table></div>`;
  }
  function sumTable(sum, j) {
    const r = sum.rows.filter(x => x.recs);
    if (!r.length) return '';
    const open = g()?.open || new Set(), canBrk = !!j?.data;
    const cell = (x, f) => x.k === 'doc_issue' || (x.k === 'nil' && f !== 'txval') ? '' : inr(x[f]);
    return `${canBrk ? `<div class="row-between g1-sumbar"><span class="muted small">Click a table to see its invoices and amounts.</span><span class="btns"><button class="sm" data-act="g1BrkAll">${open.size ? 'Collapse all' : 'Expand all'}</button><button class="sm" data-act="g1BrkXl">Download breakup (Excel)</button></span></div>` : ''}
    <table class="tbl g1-sum"><thead><tr><th>Table</th><th class="r">Records</th><th class="r">Taxable value</th><th class="r">IGST</th><th class="r">CGST</th><th class="r">SGST</th><th class="r">Cess</th></tr></thead><tbody>
      ${r.map(x => { const b = canBrk && open.has(x.k) ? breakup(x.k, j.data, j.names) : null;
        return `<tr class="${canBrk ? 'g1-click' : ''} ${b ? 'on' : ''}" ${canBrk ? `data-act="g1Brk" data-k="${x.k}" title="Show breakup"` : ''}><td>${canBrk ? `<span class="g1-car">${b ? '▾' : '▸'}</span> ` : ''}${esc(x.label)}</td><td class="r">${x.recs}</td><td class="r">${x.k === 'doc_issue' ? '' : inr(x.txval)}</td><td class="r">${cell(x, 'iamt')}</td><td class="r">${cell(x, 'camt')}</td><td class="r">${cell(x, 'samt')}</td><td class="r">${cell(x, 'csamt')}</td></tr>
        ${b ? `<tr class="g1-det"><td colspan="7">${b.rows.length ? brkTable(b) : '<p class="muted small">No lines.</p>'}</td></tr>` : ''}`; }).join('')}</tbody></table>`;
  }
  A.g1Brk = ({ k }) => { const s = g(); s.open ||= new Set(); s.open.has(k) ? s.open.delete(k) : s.open.add(k); draw(); };
  A.g1BrkAll = () => { const s = g(); s.open = s.open?.size ? new Set() : new Set(s.json.sum.rows.filter(x => x.recs).map(x => x.k)); draw(); };
  A.g1BrkXl = () => {
    const s = g(), j = s.json, wb = XLSX.utils.book_new();
    const sumAoa = [['Table', 'Records', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Cess'], ...j.sum.rows.filter(x => x.recs).map(x => [x.label, x.recs, x.txval, x.iamt, x.camt, x.samt, x.csamt])];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sumAoa), 'Summary');
    for (const x of j.sum.rows.filter(x => x.recs)) {
      const b = breakup(x.k, j.data, j.names); if (!b) continue;
      const ws = XLSX.utils.aoa_to_sheet([b.cols, ...b.rows]); ws['!cols'] = b.cols.map(c => ({ wch: Math.max(10, c.length + 2) }));
      XLSX.utils.book_append_sheet(wb, ws, x.k.toUpperCase().slice(0, 31));
    }
    XLSX.writeFile(wb, `${ret().replace('-', '')}_${s.gstin}_${s.fp}_breakup.xlsx`);
  };
  const msgs = (errs, warns) => `${errs.length ? `<div class="g1-msg err"><b>${errs.length} error${errs.length === 1 ? '' : 's'} — the portal will reject this file</b><ul>${errs.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
    ${warns.length ? `<div class="g1-msg warn"><b>Check before uploading</b><ul>${warns.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}`;

  function s1(s, p) {
    const j = s.json;
    const tl = s.tally || {}, src = s.src || 'tally';
    return `<div class="g1-src"><button class="${src === 'tally' ? 'on' : ''}" data-act="g1Src" data-v="tally">Fetch from Tally</button><button class="${src === 'file' ? 'on' : ''}" data-act="g1Src" data-v="file">Browse JSON file</button></div>
      ${src === 'tally' ? `<p class="small">Reads the ${s.quarterly ? 'quarter’s' : 'month’s'} sales, credit notes and debit notes from Tally through its ODBC port and builds the ${ret()} JSON. Keep Tally open with the client’s company loaded.</p>
        <div class="g1-tally">
          <label>Tally port<input id="g1Port" value="${esc(tl.port || lsGet('tallyPort') || '9000')}" inputmode="numeric" size="6"></label>
          ${tl.companies ? `<label class="grow">Company in Tally<select id="g1Cmp">${tl.companies.map(c => `<option ${c.name === tl.company ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>` : ''}
          <button class="${tl.companies ? '' : 'primary'}" data-act="g1TallyConnect">${tl.companies ? 'Refresh list' : 'Connect to Tally'}</button>
          ${tl.companies ? `<button class="primary" data-act="g1TallyFetch">Fetch ${esc(fpLabel(s.fp))}${s.quarterly ? ' quarter' : ''}</button>` : ''}</div>
        ${s.b2bFrom ? `<p class="muted tiny">B2B invoices and notes dated before ${isoToDisp(s.b2bFrom.slice(0, 4) + '-' + s.b2bFrom.slice(4, 6) + '-' + s.b2bFrom.slice(6))} are left out — they were filed in IFF. The HSN summary and documents issued cover the whole quarter.</p>` : ''}
        <p class="muted tiny">First time: in Tally, F1 Help → Settings → Connectivity → Client/Server configuration → TallyPrime acts as “Both”, Enable ODBC “Yes”, Port 9000. If Chrome asks to let this site access apps on your computer, choose Allow.</p>
        ${tl.failed && !ctx.extVer() ? ctx.extCard(true) : ''}
        <details class="g1-alt"${tl.failed ? ' open' : ''}><summary>Can’t connect? Use a Tally XML file instead</summary>
          <p class="small">In Tally: <b>Day Book</b> → F2 period ${esc(fpLabel(s.fp))}${s.quarterly ? ' quarter' : ''} → <b>Export</b> (Alt+E) → Format <b>XML (Data Interchange)</b> → Export. For better HSN and tax detection, also export <b>Masters</b> (Alt+E from Gateway → Masters, XML) and pick both files together.</p>
          <label class="g1-drop"><b>Browse Tally XML</b><span class="muted tiny">Day Book XML, optionally with the masters XML</span><input type="file" multiple accept=".xml,text/xml" data-change="g1TallyXml"></label></details>
        ${j?.tally ? `<p class="small mt"><b>${j.tally.count}</b> voucher${j.tally.count === 1 ? '' : 's'} read from <b>${esc(j.tally.company)}</b>.</p>` : ''}`
      : `<p class="small">Choose the ${ret()} JSON generated by the GST Offline Tool or your accounting software. It is checked against this GSTIN and period before you upload it on the portal.</p>
      <label class="g1-drop">${j ? `<b>${esc(j.file.name)}</b><span class="muted tiny">Choose another file</span>` : `<b>Browse JSON file</b><span class="muted tiny">.json — up to 10 MB</span>`}<input type="file" accept=".json,application/json" data-change="g1Json"></label>`}
      ${j && (src === 'file') === !j.tally ? `${j.sum.errs.length || j.sum.warns.length ? msgs(j.sum.errs, j.sum.warns) : '<div class="g1-msg ok"><b>No errors found.</b> GSTIN and period match.</div>'}${sumTable(j.sum, j)}
        <div class="btns mt"><button class="primary" data-act="g1SaveJson" ${j.sum.errs.length ? 'disabled' : ''}>Save JSON and continue</button><button data-act="g1JsonDl">Download JSON</button>${j.sum.errs.length ? `<span class="muted small">${j.tally ? 'Correct these in Tally and fetch again.' : 'Fix the errors in the source file and browse it again.'}</span>` : ''}</div>`
      : p.jsonDoc ? `<div class="g1-msg ok">Saved: <b>${esc(p.jsonName)}</b>${p.savedAt ? ` on ${isoToDisp(p.savedAt.slice(0, 10))}` : ''}. <a href="#" data-act="g1Step" data-i="2">Go to step 2</a></div>${p.sum ? sumTable({ rows: p.sum }) : ''}` : ''}`;
  }

  function s2(s, p) {
    const auto = (ctx.extVer() || '') >= '1.2.0';
    return `<div class="g1-auto">
        <p class="small"><b>Upload JSON to GST portal</b> runs on autopilot:</p>
        <ol class="g1-howto small">
          <li>Opens the GST portal and fills the client's user ID and password — <b>you type the CAPTCHA and click Login</b>.</li>
          <li>Returns Dashboard → ${esc(fpLabel(s.fp))} → <b>${ret()}</b> → Prepare offline → uploads <b>${esc(p.jsonName || 'the JSON')}</b>.</li>
          <li>Waits for <i>Processed</i> (stops and tells you if it is <i>Processed with error</i>).</li>
          <li>Prepare online → <b>Generate summary</b>, then stops. You check the summary and file with DSC or EVC yourself.</li></ol>
        <p class="muted tiny">A bar at the bottom of the portal shows what the autopilot is doing, with a Stop button. If a step can't be found, it tells you which button to click and continues from the next page.</p></div>
      ${auto ? '' : `<div class="mt">${ctx.extCard(true)}<p class="muted tiny">The autopilot needs CA Desk Helper version 1.2. Without it, the button only opens the portal and copies the password.</p></div>`}
      <div class="btns mt">
        <button class="primary" data-act="g1Portal" ${p.jsonDoc ? '' : 'disabled title="Save the JSON in step 1 first"'}>Upload JSON to GST portal</button>
        ${p.jsonDoc ? `<button data-act="g1DownloadJson">Download JSON again</button>` : ''}
        <button data-act="g1Uploaded">${p.uploaded ? 'Filed on portal ✓' : 'I have filed it on the portal'}</button></div>`;
  }

  function s3(s, p) {
    const d = s.pdf;
    return `<p class="small">Choose the filed ${ret()} PDF downloaded from the portal. The ARN and its date are read from the PDF. You can also paste the ARN from the portal's e-mail or SMS.</p>
      <label class="g1-drop">${d ? `<b>${esc(d.file.name)}</b><span class="muted tiny">Choose another file</span>` : `<b>Browse filed ${ret()} PDF</b><span class="muted tiny">.pdf — downloaded from the portal after filing</span>`}<input type="file" accept=".pdf,application/pdf" data-change="g1Pdf"></label>
      ${d?.wrongGstin ? `<div class="g1-msg err">This PDF is for GSTIN <b>${esc(d.wrongGstin)}</b>, not ${esc(s.gstin)}. Check you picked the right file.</div>` : ''}
      ${d && !d.arn ? '<div class="g1-msg warn">No ARN found in this PDF. Type it below — it is in the e-mail and SMS the portal sends after filing.</div>' : ''}
      <form data-form="g1Filed" class="grid narrow mt">
        <label>ARN<input name="arn" value="${esc(d?.arn || '')}" placeholder="AA0911260123456" pattern="[Aa][Aa][0-9A-Za-z]{13}" title="15 characters starting with AA" required class="mono"></label>
        <label>Date of filing<input type="date" name="filedOn" value="${esc(d?.date || todayISO())}" required></label>
        <div class="span2 btns"><button class="primary" ${d?.wrongGstin ? 'disabled' : ''}>Save and mark filed</button><button type="button" data-act="closeModal">Close</button></div></form>
      <p class="muted tiny">The PDF is saved in the client's Documents and in the task's Output files, so you can send it to the client from the task.</p>`;
  }

  const lsGet = k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
  // QRMP: months of the quarter whose IFF is filed (from the start of the quarter) → B2B from the next month
  function iffCovered(s) {
    const y = +s.fp.slice(2), m = +s.fp.slice(0, 2); let from = '';
    for (let k = m - 2; k < m; k++) {
      const dt = new Date(y, k - 1, 1), id = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      const f = S.allFilings[`${s.cid}|IFF-${id}@${s.gstin}`];
      if (f?.status !== 'filed') break;
      const nx = new Date(y, k, 1); from = `${nx.getFullYear()}${String(nx.getMonth() + 1).padStart(2, '0')}01`;
    }
    return from;
  }
  A.g1Src = ({ v }) => { g().src = v; lsSet('g1src', v); draw(); };
  const tallyOpt = () => { const port = (document.getElementById('g1Port')?.value || g().tally?.port || '9000').replace(/\D/g, '') || '9000'; lsSet('tallyPort', port); return { port }; };
  A.g1TallyConnect = () => guard(async () => {
    const s = g(), opt = tallyOpt(); busy(true, 'Connecting to Tally…');
    let companies;
    try { companies = await tallyCompanies(opt); } catch (e) { s.tally = { ...(s.tally || {}), port: opt.port, failed: true }; draw(); throw e; }
    const remembered = lsGet('tallyCmp:' + s.gstin);
    const words = ctx.dispName(S.clients.find(c => c.id === s.cid) || {}).toLowerCase().replace(/private|limited|pvt|ltd|llp|[^a-z ]/g, '').split(/\s+/).filter(w => w.length > 2);
    const pick = companies.find(c => c.name === remembered) || companies.find(c => c.gstin === s.gstin) || companies.find(c => words.length && words.every(w => c.name.toLowerCase().includes(w))) || companies.find(c => words[0] && c.name.toLowerCase().includes(words[0])) || companies[0];
    s.tally = { port: opt.port, companies, company: pick.name }; draw();
  }, 'Connected to Tally');
  A.g1TallyFetch = () => guard(async () => {
    const s = g(), opt = tallyOpt(), company = document.getElementById('g1Cmp').value;
    s.tally = { ...s.tally, company, port: opt.port }; lsSet('tallyCmp:' + s.gstin, company);
    const r = await fetchGstr1({ company, gstin: s.gstin, fp: s.fp, iff: s.iff, quarterly: s.quarterly, b2bFrom: s.b2bFrom }, opt, m => busy(true, m));
    const file = new File([JSON.stringify(r.json)], `${ret().replace('-', '')}_${s.gstin}_${s.fp}_Tally.json`, { type: 'application/json' });
    const sum = checkJson(r.json, { gstin: s.gstin, fp: s.fp, iff: s.iff, noHsnCheck: !!s.b2bFrom });
    sum.warns = [...r.warns, ...sum.warns];
    s.json = { file, data: r.json, names: r.names, sum, tally: { count: r.count, company } }; draw();
  });
  C.g1TallyXml = el => {
    const files = [...el.files]; el.value = ''; if (!files.length) return;
    guard(async () => {
      const s = g(); busy(true, 'Reading Tally XML…');
      const texts = []; for (const f of files) texts.push(await readTallyFile(f));
      const r = gstr1FromXml(texts, { gstin: s.gstin, fp: s.fp, iff: s.iff, quarterly: s.quarterly, b2bFrom: s.b2bFrom });
      const file = new File([JSON.stringify(r.json)], `${ret().replace('-', '')}_${s.gstin}_${s.fp}_Tally.json`, { type: 'application/json' });
      const sum = checkJson(r.json, { gstin: s.gstin, fp: s.fp, iff: s.iff, noHsnCheck: !!s.b2bFrom });
      sum.warns = [...r.warns, ...sum.warns];
      s.json = { file, data: r.json, names: r.names, sum, tally: { count: r.count, company: files.map(f => f.name).join(', ') } }; draw();
    });
  };
  A.g1JsonDl = () => { const j = g().json; if (j) saveBlob(j.file, j.file.name); };
  A.g1Step = ({ i }) => { g().step = +i; draw(); };
  C.g1Json = el => {
    const f = el.files[0]; el.value = ''; if (!f) return;
    guard(async () => {
      if (f.size > 10 * 1024 * 1024) throw new Error('The JSON is over 10 MB. Split it or upload it directly on the portal.');
      let j; try { j = JSON.parse(await f.text()); } catch { j = null; }
      const s = g(); s.json = { file: f, data: j, names: {}, sum: checkJson(j, { gstin: s.gstin, fp: s.fp, iff: s.iff }) }; draw();
    });
  };
  A.g1SaveJson = () => guard(async () => {
    const s = g(), j = s.json;
    const t = await T.ensure(s.cid, s.key, s.alt, s.form, s.period, s.due);
    busy(true, 'Saving JSON…');
    const id = await saveFile(s.cid, j.file, 'Working', { taskId: t.id, filingKey: s.key, kind: 'working', byRole: 'ca' });
    const rows = j.sum.rows.filter(x => x.recs).map(({ k, label, recs, txval, iamt, camt, samt, csamt }) => ({ k, label, recs, txval, iamt, camt, samt, csamt }));
    await T.patch(t.id, { g1: { ...(t.g1 || {}), jsonDoc: id, jsonName: j.file.name, savedAt: new Date().toISOString(), sum: rows, uploaded: false }, ...(t.status === 'Not started' ? { status: 'In progress' } : {}) },
      `${ret()} JSON checked and saved: ${j.file.name}`);
    if (S.tfiles?.tid === t.id) S.tfiles = null;
    s.json = null; s.step = 2; draw(); render(); draw();
  }, 'JSON saved');
  async function savedJson() {
    const s = g(), p = task()?.g1; if (!p?.jsonDoc) throw new Error('Save the JSON in step 1 first.');
    const ch = await getDocs(collection(db, 'clients', s.cid, 'docs', p.jsonDoc, 'chunks'));
    const b64 = ch.docs.sort((a, b) => a.id.localeCompare(b.id)).map(x => x.data().d).join('');
    return { name: p.jsonName, text: new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))) };
  }
  A.g1DownloadJson = () => guard(async () => { const j = await savedJson(); saveBlob(new Blob([j.text], { type: 'application/json' }), j.name); });
  A.g1Portal = () => guard(async () => {
    const s = g();
    if ((ctx.extVer() || '') < '1.2.0') return portalLogin(s.cid, s.gstin);
    const [j, cred] = [await savedJson(), await ctx.gstCred(s.cid, s.gstin)];
    if (!cred) throw new Error('No GST login is saved for this GSTIN. Add it in the client → Portal logins, then try again.');
    const y = +s.fp.slice(2), m = +s.fp.slice(0, 2), fy = m >= 4 ? `${y}-${String((y + 1) % 100).padStart(2, '0')}` : `${y - 1}-${String(y % 100).padStart(2, '0')}`;
    const quarter = m >= 4 ? Math.ceil((m - 3) / 3) : 4;
    const job = { cid: s.cid, key: s.key, alt: s.alt || '', form: s.form, period: s.period, due: s.due, gstin: s.gstin, ret: s.iff ? 'IFF' : 'GSTR1', fp: s.fp, fy, quarter, month: m, periodLabel: fpLabel(s.fp) + (s.quarterly ? ' (quarter)' : ''), json: j.text, jsonName: j.name };
    window.postMessage({ type: 'CAPM_G1', url: 'https://services.gst.gov.in/services/login', username: cred.username || '', password: cred.password || '', job }, location.origin);
    const t = task(); if (t) await T.patch(t.id, {}, `${ret()} autopilot started on the GST portal`);
    toast('GST portal opened — type the CAPTCHA and log in. The autopilot does the rest up to Generate summary.', 7000);
  });
  A.g1Uploaded = () => guard(async () => {
    const s = g(), t = await T.ensure(s.cid, s.key, s.alt, s.form, s.period, s.due);
    if (!t.g1?.uploaded) await T.patch(t.id, { g1: { ...(t.g1 || {}), uploaded: true, uploadedAt: new Date().toISOString() }, ...(['Not started', 'Waiting on client'].includes(t.status) ? { status: 'In progress' } : {}) }, `${ret()} JSON uploaded on the GST portal`);
    s.step = 3; draw(); render(); draw();
  });
  C.g1Pdf = el => {
    const f = el.files[0]; el.value = ''; if (!f) return;
    guard(async () => {
      busy(true, 'Reading the PDF…');
      const text = await extractText(f, m => busy(true, m), { maxOcrPages: 2 });
      g().pdf = { file: f, ...readArn(text, g().gstin) }; draw();
      if (!g().pdf.arn) toast('No ARN found in the PDF — type it in.', 5000);
    });
  };
  ctx.F.g1Filed = fd => guard(async () => {
    const s = g(), arn = String(fd.get('arn')).trim().toUpperCase(), filedOn = fd.get('filedOn');
    const t = await T.ensure(s.cid, s.key, s.alt, s.form, s.period, s.due);
    let pdfDoc = '';
    if (s.pdf?.file) { busy(true, 'Saving PDF…'); pdfDoc = await saveFile(s.cid, s.pdf.file, 'Output', { taskId: t.id, filingKey: s.key, kind: 'output', byRole: 'ca' }); }
    const data = { status: 'filed', filedOn, ack: arn, remarks: `${ret()} filed${s.pdf?.file ? ' — PDF saved' : ''}`, pdfDoc, by: S.profile.email, at: fs.serverTimestamp() };
    await setDoc(doc(db, 'clients', s.cid, 'filings', s.key), data);
    S.allFilings[`${s.cid}|${s.key}`] = data; if (s.cid === S.cid) S.filings[s.key] = data;
    await T.patch(t.id, { g1: { ...(t.g1 || {}), arn, filedOn, pdfDoc } }, `${ret()} filed — ARN ${arn} dated ${isoToDisp(filedOn)}${s.pdf?.file ? `; PDF saved: ${s.pdf.file.name}` : ''}`);
    await T.markDone(s.cid, s.key, arn);
    if (S.tfiles?.tid === t.id) S.tfiles = null;
    S.g1 = null; closeModal(); render();
  }, 'Filed — ARN and PDF saved');
  // ARN + filed PDF sent back by the CA Desk Helper autopilot after the return is filed on the portal
  const doneIds = new Set(), queue = [];
  async function applyResult(r) {
    if (!r?.cid || !r.key) return;
    const sig = `${r.id}|${r.arn || ''}|${r.pdf ? r.pdf.length : 0}`; if (doneIds.has(sig)) return; doneIds.add(sig);
    if (!S.profile || !S.clients?.length) { doneIds.delete(sig); queue.push(r); return; }
    const name = ctx.dispName(S.clients.find(c => c.id === r.cid) || {}), retName = r.ret === 'IFF' ? 'IFF' : 'GSTR-1';
    await guard(async () => {
      const t = await T.ensure(r.cid, r.key, r.alt, r.form, r.period, r.due);
      const prev = S.allFilings[`${r.cid}|${r.key}`] || {};
      let pdfDoc = prev.pdfDoc || '';
      if (r.pdf) {
        const bytes = Uint8Array.from(atob(r.pdf), c => c.charCodeAt(0));
        pdfDoc = await saveFile(r.cid, new File([bytes], r.pdfName || `${retName}_${r.gstin}_${r.fp}.pdf`, { type: 'application/pdf' }), 'Output', { taskId: t.id, filingKey: r.key, kind: 'output', byRole: 'ca' });
      }
      const arn = r.arn || prev.ack || '', filedOn = r.filedOn || prev.filedOn || todayISO();
      if (arn) {
        const data = { ...prev, status: 'filed', filedOn, ack: arn, remarks: `${retName} filed on the GST portal (autopilot)`, pdfDoc, by: S.profile.email, at: fs.serverTimestamp() };
        await setDoc(doc(db, 'clients', r.cid, 'filings', r.key), data);
        S.allFilings[`${r.cid}|${r.key}`] = data; if (r.cid === S.cid) S.filings[r.key] = data;
        await T.patch(t.id, { g1: { ...(t.g1 || {}), arn, filedOn, pdfDoc, uploaded: true } }, r.pdf ? `${retName} PDF saved from the GST portal` : `${retName} filed — ARN ${arn} dated ${isoToDisp(filedOn)} (from the GST portal)`);
        await T.markDone(r.cid, r.key, arn);
      }
      if (S.tfiles?.tid === t.id) S.tfiles = null;
      window.postMessage({ type: 'CAPM_G1_ACK', id: r.id }, location.origin);
      if (S.g1?.key === r.key && S.g1?.cid === r.cid) { S.g1 = null; closeModal(); }
      render();
    }, r.arn ? `${retName} of ${name} filed — ARN ${r.arn}${r.pdf ? ' and PDF' : ''} saved` : `${retName} PDF of ${name} saved`);
  }
  window.addEventListener('message', e => { if (e.source === window && e.data?.type === 'CAPM_G1_RESULT') applyResult(e.data.result); });
  setInterval(() => { if (queue.length && S.profile && S.clients?.length) applyResult(queue.shift()); }, 3000);
  return G;
}
