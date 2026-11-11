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

  function sumTable(sum) {
    const r = sum.rows.filter(x => x.recs);
    if (!r.length) return '';
    return `<table class="tbl g1-sum"><thead><tr><th>Table</th><th class="r">Records</th><th class="r">Taxable value</th><th class="r">IGST</th><th class="r">CGST</th><th class="r">SGST</th><th class="r">Cess</th></tr></thead><tbody>
      ${r.map(x => `<tr><td>${esc(x.label)}</td><td class="r">${x.recs}</td><td class="r">${x.k === 'doc_issue' ? '' : inr(x.txval)}</td><td class="r">${x.k === 'doc_issue' || x.k === 'nil' ? '' : inr(x.iamt)}</td><td class="r">${x.k === 'doc_issue' || x.k === 'nil' ? '' : inr(x.camt)}</td><td class="r">${x.k === 'doc_issue' || x.k === 'nil' ? '' : inr(x.samt)}</td><td class="r">${x.k === 'doc_issue' || x.k === 'nil' ? '' : inr(x.csamt)}</td></tr>`).join('')}</tbody></table>`;
  }
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
        <details class="g1-alt"${tl.failed ? ' open' : ''}><summary>Can’t connect? Use a Tally XML file instead</summary>
          <p class="small">In Tally: <b>Day Book</b> → F2 period ${esc(fpLabel(s.fp))}${s.quarterly ? ' quarter' : ''} → <b>Export</b> (Alt+E) → Format <b>XML (Data Interchange)</b> → Export. For better HSN and tax detection, also export <b>Masters</b> (Alt+E from Gateway → Masters, XML) and pick both files together.</p>
          <label class="g1-drop"><b>Browse Tally XML</b><span class="muted tiny">Day Book XML, optionally with the masters XML</span><input type="file" multiple accept=".xml,text/xml" data-change="g1TallyXml"></label></details>
        ${j?.tally ? `<p class="small mt"><b>${j.tally.count}</b> voucher${j.tally.count === 1 ? '' : 's'} read from <b>${esc(j.tally.company)}</b>.</p>` : ''}`
      : `<p class="small">Choose the ${ret()} JSON generated by the GST Offline Tool or your accounting software. It is checked against this GSTIN and period before you upload it on the portal.</p>
      <label class="g1-drop">${j ? `<b>${esc(j.file.name)}</b><span class="muted tiny">Choose another file</span>` : `<b>Browse JSON file</b><span class="muted tiny">.json — up to 10 MB</span>`}<input type="file" accept=".json,application/json" data-change="g1Json"></label>`}
      ${j && (src === 'file') === !j.tally ? `${j.sum.errs.length || j.sum.warns.length ? msgs(j.sum.errs, j.sum.warns) : '<div class="g1-msg ok"><b>No errors found.</b> GSTIN and period match.</div>'}${sumTable(j.sum)}
        <div class="btns mt"><button class="primary" data-act="g1SaveJson" ${j.sum.errs.length ? 'disabled' : ''}>Save JSON and continue</button><button data-act="g1JsonDl">Download JSON</button>${j.sum.errs.length ? `<span class="muted small">${j.tally ? 'Correct these in Tally and fetch again.' : 'Fix the errors in the source file and browse it again.'}</span>` : ''}</div>`
      : p.jsonDoc ? `<div class="g1-msg ok">Saved: <b>${esc(p.jsonName)}</b>${p.savedAt ? ` on ${isoToDisp(p.savedAt.slice(0, 10))}` : ''}. <a href="#" data-act="g1Step" data-i="2">Go to step 2</a></div>${p.sum ? sumTable({ rows: p.sum }) : ''}` : ''}`;
  }

  function s2(s, p) {
    return `<ol class="g1-howto small">
        <li>Sign in to the GST portal — the button below opens it and fills the client's user ID and password. Type the CAPTCHA yourself.</li>
        <li><b>Services → Returns → Returns Dashboard</b> → financial year and ${s.iff ? 'month' : 'period'} ${esc(fpLabel(s.fp))} → <b>${ret()}</b> → <b>Prepare offline</b>.</li>
        <li><b>Upload</b> → <b>Choose file</b> → pick <b>${esc(p.jsonName || 'the JSON')}</b>. Wait until the status shows <i>Processed</i>. If it shows <i>Processed with error</i>, download the error report.</li>
        <li><b>Prepare online</b> → <b>Generate summary</b> → tick the declaration → <b>File statement</b> with DSC or EVC (OTP goes to the authorised signatory).</li>
        <li>After filing, <b>View</b> → <b>Download PDF</b> and bring the PDF to step 3.</li></ol>
      <div class="btns mt">
        <button class="primary" data-act="g1Portal">Open GST portal</button>
        ${p.jsonDoc ? `<button data-act="g1DownloadJson">Download JSON again</button>` : ''}
        <button data-act="g1Uploaded">${p.uploaded ? 'Uploaded ✓' : 'I have uploaded it on the portal'}</button></div>
      <p class="muted tiny mt">The GST portal does not let other websites upload returns directly. Automatic upload, filing and ARN download are possible through a GST Suvidha Provider (GSP) account. Once you have one, it can be connected here.</p>`;
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
    s.json = { file, sum, tally: { count: r.count, company } }; draw();
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
      s.json = { file, sum, tally: { count: r.count, company: files.map(f => f.name).join(', ') } }; draw();
    });
  };
  A.g1JsonDl = () => { const j = g().json; if (j) saveBlob(j.file, j.file.name); };
  A.g1Step = ({ i }) => { g().step = +i; draw(); };
  C.g1Json = el => {
    const f = el.files[0]; el.value = ''; if (!f) return;
    guard(async () => {
      if (f.size > 10 * 1024 * 1024) throw new Error('The JSON is over 10 MB. Split it or upload it directly on the portal.');
      let j; try { j = JSON.parse(await f.text()); } catch { j = null; }
      const s = g(); s.json = { file: f, sum: checkJson(j, { gstin: s.gstin, fp: s.fp, iff: s.iff }) }; draw();
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
  A.g1DownloadJson = () => guard(async () => {
    const s = g(), p = task()?.g1; if (!p?.jsonDoc) return;
    const ch = await getDocs(collection(db, 'clients', s.cid, 'docs', p.jsonDoc, 'chunks'));
    const b64 = ch.docs.sort((a, b) => a.id.localeCompare(b.id)).map(x => x.data().d).join('');
    saveBlob(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: 'application/json' }), p.jsonName);
  });
  A.g1Portal = () => guard(async () => { const s = g(); await portalLogin(s.cid, s.gstin); });
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
  return G;
}
