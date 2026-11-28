// Bank import (Suvit-style): a bank statement (Excel / CSV / PDF) as one grid – every transaction with its ledger,
// auto-filled from rules, past entries and names in the narration; bulk-assign, split, balance check, "already in
// Tally" check, then post Payment / Receipt / Contra vouchers to Tally in one go. Kept per client in
// clients/{cid}/bankimports/{id} so a statement can be finished later.
import { extractText, toISO } from './extract.js';
import { tallyPost, tallyEnv, tallyParse, tallyEsc, tallyImport } from './tally.js';

const r2 = v => Math.round((+v || 0) * 100) / 100;
const inr = v => (+v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ymd = iso => String(iso || '').replace(/-/g, '');
const num = v => { if (typeof v === 'number') return v; const s = String(v ?? '').replace(/[,\s₹]/g, '').replace(/^\((.*)\)$/, '-$1'); const m = s.match(/-?\d+(\.\d+)?/); return m ? +m[0] : 0; };
const FILTERS = [['all', 'All'], ['todo', 'Ledger missing'], ['set', 'Ledger set'], ['out', 'Withdrawals'], ['in', 'Deposits'], ['dup', 'Already in Tally'], ['posted', 'Posted']];

// Excel date serial / text → ISO
function isoDate(v) {
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  if (typeof v === 'number' && v > 20000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 864e5)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
  const s = String(v || '').trim(), x = toISO(s); if (x) return x;
  const M = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})\b/); if (m) return `20${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;   // dd/mm/yy (HDFC, ICICI)
  m = s.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3})[a-z]*[\s\-\/,]+(\d{2,4})\b/); if (m && M[m[2].toLowerCase()]) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${String(M[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}
// find the header row and the columns of a bank statement sheet
function detect(rows) {
  const W = { date: /^(txn|tran|transaction|value)?\s*date|^date$/i, narr: /narration|description|particulars|details|remarks/i, ref: /chq|cheque|ref|utr|instrument/i,
    debit: /withdrawal|debit|dr\b|paid out|payments?$/i, credit: /deposit|credit|cr\b|paid in|receipts?$/i, bal: /balance/i, amt: /^amount|amount\s*\(?(inr|rs)/i, drcr: /^(dr|cr)\s*\/\s*(cr|dr)$|^type$|^cr\/dr$|^dr\/cr$/i };
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const h = (rows[i] || []).map(x => String(x ?? '').trim()); const col = {};
    h.forEach((x, j) => { if (!x) return;
      if (col.date == null && W.date.test(x) && !/value/i.test(x)) col.date = j; else if (col.date == null && /value\s*date/i.test(x)) col.vdate = j;
      if (col.narr == null && W.narr.test(x)) col.narr = j;
      if (col.ref == null && W.ref.test(x) && !W.narr.test(x)) col.ref = j;
      if (col.debit == null && W.debit.test(x) && !W.bal.test(x)) col.debit = j;
      if (col.credit == null && W.credit.test(x) && !W.bal.test(x) && j !== col.debit) col.credit = j;
      if (col.bal == null && W.bal.test(x)) col.bal = j;
      if (col.amt == null && W.amt.test(x)) col.amt = j;
      if (col.drcr == null && W.drcr.test(x)) col.drcr = j; });
    if (col.date == null && col.vdate != null) col.date = col.vdate;
    if (col.date != null && col.narr != null && ((col.debit != null && col.credit != null) || col.amt != null)) return { head: i, col, headers: h };
  }
  return null;
}
function rowsFromSheet(rows, m) {
  const out = []; const c = m.col;
  for (let i = m.head + 1; i < rows.length; i++) {
    const r = rows[i] || []; const date = isoDate(r[c.date]); if (!date) continue;
    let debit = c.debit != null ? Math.abs(num(r[c.debit])) : 0, credit = c.credit != null ? Math.abs(num(r[c.credit])) : 0;
    if (c.amt != null && !debit && !credit) { const a = num(r[c.amt]), t = String(r[c.drcr] ?? '').toLowerCase(); if (/^d|dr|debit|withdraw/.test(t) || a < 0) debit = Math.abs(a); else credit = Math.abs(a); }
    if (!debit && !credit) continue;
    const narr = String(r[c.narr] ?? '').replace(/\s+/g, ' ').trim();
    out.push({ date, narration: narr, ref: c.ref != null ? String(r[c.ref] ?? '').trim() : (narr.match(/\b(?:UTR|REF|CHQ|NEFT|IMPS|RTGS)[\s:\/-]*([A-Z0-9]{6,})/i) || [])[1] || '', debit: r2(debit), credit: r2(credit), balance: c.bal != null && String(r[c.bal] ?? '').trim() !== '' ? r2(num(r[c.bal]) * (/dr/i.test(String(r[c.bal])) ? -1 : 1)) : null });
  }
  return out;
}

export function initBankImport(ctx) {
  const { S, A, C, F, esc, toast, modal, closeModal, guard, render, isoToDisp, db, fs, busy, k } = ctx;
  const { doc, getDocs, setDoc, updateDoc, deleteDoc, collection, serverTimestamp } = fs;
  const BI = {};
  const b = () => (k.st().bi ||= { list: null, cur: null, f: 'all', q: '', sel: new Set() });
  const L = () => k.L();
  const BANKISH = /bank accounts|bank od|bank occ|cash-in-hand/i;
  const typeFor = (row, ledger) => BANKISH.test(k.led(ledger)?.r || '') ? 'Contra' : row.credit ? 'Receipt' : 'Payment';
  const amt = r => r.credit || r.debit;

  async function loadList() {
    const s = k.st(), q = await getDocs(collection(db, 'clients', s.cid, 'bankimports'));
    b().list = q.docs.map(d => ({ id: d.id, ...d.data() })).sort((x, y) => (y.to || '').localeCompare(x.to || ''));
    if (!b().cur && b().list.length) b().cur = b().list[0].id;
    render();
  }
  const cur = () => (b().list || []).find(x => x.id === b().cur);
  async function save(im) { const s = k.st(); await setDoc(doc(db, 'clients', s.cid, 'bankimports', im.id), { ...im, updatedAt: serverTimestamp() }); }

  // ledger suggestion: your rules → a ledger name in the narration → what this narration was posted to before → expense words
  function suggest(row, bank) {
    const rules = k.meta().bankRules || [], text = (row.narration || '').toUpperCase();
    for (const r of rules) if (r.kw && text.includes(r.kw.toUpperCase()) && (!r.dir || r.dir === (row.credit ? 'in' : 'out'))) return { ledger: r.ledger, how: 'rule' };
    const d = k.draftFromBank(row, bank);
    return d.v.party ? { ledger: d.v.party, how: 'auto' } : { ledger: '', how: '' };
  }
  function autofill(im, force) {
    let n = 0;
    for (const r of im.rows) { if (r.status === 'posted' || (r.ledger && !force && r.how === 'you')) continue; if (r.ledger && !force) continue;
      const g = suggest(r, im.bank); if (g.ledger) { r.ledger = g.ledger; r.how = g.how; r.type = typeFor(r, g.ledger); n++; } }
    return n;
  }
  // running balance check: each balance = previous balance − withdrawal + deposit
  function balCheck(im) {
    let prev = im.opening, bad = 0;
    for (const r of im.rows) { if (r.balance == null) { r.balBad = false; continue; } if (prev != null) { const exp = r2(prev - r.debit + r.credit); r.balBad = Math.abs(exp - r.balance) > 0.5; if (r.balBad) bad++; } prev = r.balance; }
    return bad;
  }

  /* ---------- import a statement ---------- */
  async function readFile(file) {
    const name = file.name.toLowerCase();
    if (/\.(xlsx|xls|csv)$/.test(name)) {
      if (!window.XLSX) throw new Error('Excel reader is still loading – try again in a moment.');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      for (const sn of wb.SheetNames) { const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '' }); const m = detect(rows); if (m) return { rows: rowsFromSheet(rows, m), how: `Excel (${sn})` }; }
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
      return { need: rows };
    }
    const text = await extractText(file, m => busy(true, m));
    const rows = k.bankFromText(text).transactions || [];
    return { rows, how: 'PDF' };
  }
  async function create(file, bank, rows, how) {
    const s = k.st();
    rows = rows.filter(r => r.date && (r.debit || r.credit)).sort((x, y) => x.date.localeCompare(y.date));
    if (!rows.length) throw new Error('No transactions found in this statement. For a scanned PDF, use the Excel / CSV download from net banking.');
    const first = rows[0], opening = first.balance != null ? r2(first.balance + first.debit - first.credit) : null;
    const im = { id: `bi${Date.now()}`, bank, file: file.name, how, from: rows[0].date, to: rows[rows.length - 1].date, opening, closing: rows[rows.length - 1].balance, createdAt: new Date().toISOString(), by: S.profile?.email || '',
      rows: rows.map((r, i) => ({ i, date: r.date, narration: r.narration || '', ref: r.ref || '', debit: r2(r.debit), credit: r2(r.credit), balance: r.balance ?? null, ledger: '', type: r.credit ? 'Receipt' : 'Payment', how: '', status: '', split: null })) };
    const n = autofill(im);
    await save(im); b().list = [im, ...(b().list || [])]; b().cur = im.id; b().f = 'all'; b().sel = new Set();
    return { rows: im.rows.length, n };
  }

  /* ---------- already in Tally? (date + amount on this bank ledger) ---------- */
  async function checkTally(im) {
    const company = k.meta().company; if (!company) throw new Error('Choose the Tally company first.');
    const f = new Date(im.from + 'T00:00');
    const vars = `<SVCURRENTCOMPANY>${tallyEsc(company)}</SVCURRENTCOMPANY><SVFROMDATE>${ymd(im.from)}</SVFROMDATE><SVTODATE>${ymd(im.to)}</SVTODATE>`;
    busy(true, `Checking ${im.bank} in Tally…`);
    const vd = tallyParse(await tallyPost(tallyEnv('CDBnkV', `<COLLECTION NAME="CDBnkV" ISMODIFY="No"><TYPE>Voucher</TYPE><FETCH>Date,VoucherTypeName,IsCancelled,IsOptional,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount</FETCH><FILTER>CDBnkD</FILTER></COLLECTION><SYSTEM TYPE="Formulae" NAME="CDBnkD">$Date &gt;= $$Date:"${f.getDate()}-${f.toLocaleString('en', { month: 'short' })}-${f.getFullYear()}"</SYSTEM>`, vars), k.opt()), 'vouchers');
    const kids = (el, tag) => [...(el?.children || [])].filter(c => c.tagName === tag);
    const tx = (el, tag) => (kids(el, tag)[0]?.textContent || '').trim();
    const have = new Map();   // "date|in/out|amount" → count
    for (const v of vd.getElementsByTagName('VOUCHER')) {
      if (tx(v, 'ISCANCELLED') === 'Yes' || tx(v, 'ISOPTIONAL') === 'Yes') continue;
      const d = tx(v, 'DATE'); const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      for (const e of [...kids(v, 'ALLLEDGERENTRIES.LIST'), ...kids(v, 'LEDGERENTRIES.LIST')]) {
        if (tx(e, 'LEDGERNAME') !== im.bank) continue;
        const a = num(tx(e, 'AMOUNT')); const key = `${iso}|${a < 0 ? 'in' : 'out'}|${r2(Math.abs(a))}`;   // bank debited (money in) = negative in Tally
        have.set(key, (have.get(key) || 0) + 1);
      }
    }
    let n = 0;
    for (const r of im.rows) { if (r.status === 'posted') continue; const key = `${r.date}|${r.credit ? 'in' : 'out'}|${r2(amt(r))}`;
      if (have.get(key)) { have.set(key, have.get(key) - 1); r.status = 'dup'; n++; } else if (r.status === 'dup') r.status = ''; }
    im.checkedAt = new Date().toISOString();
    return n;
  }

  /* ---------- post ---------- */
  function vxml(im, r) {
    const E = (n, a) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${tallyEsc(n)}</LEDGERNAME><ISDEEMEDPOSITIVE>${a < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${r2(a).toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
    const total = r2(amt(r)), parts = r.split?.length ? r.split : [{ ledger: r.ledger, amount: total }], lines = [];
    if (r.credit) { lines.push(E(im.bank, -total)); for (const p of parts) lines.push(E(p.ledger, r2(p.amount))); }
    else { for (const p of parts) lines.push(E(p.ledger, -r2(p.amount))); lines.push(E(im.bank, total)); }
    const type = r.type || typeFor(r, parts[0].ledger);
    return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${tallyEsc(type)}" ACTION="Create" OBJVIEW="Accounting Voucher View"><DATE>${ymd(r.date)}</DATE><EFFECTIVEDATE>${ymd(r.date)}</EFFECTIVEDATE><VOUCHERTYPENAME>${tallyEsc(type)}</VOUCHERTYPENAME>${r.ref ? `<REFERENCE>${tallyEsc(r.ref)}</REFERENCE>` : ''}<NARRATION>${tallyEsc((r.narration || '') + ' [CA Desk]')}</NARRATION>${lines.join('')}</VOUCHER></TALLYMESSAGE>`;
  }
  const missing = r => r.split?.length ? (r.split.some(p => !p.ledger || !(+p.amount)) || Math.abs(r.split.reduce((a, p) => a + (+p.amount || 0), 0) - amt(r)) > 0.01) : !r.ledger;
  async function post(im, rows) {
    const company = k.meta().company; if (!company) throw new Error('Choose the Tally company first.');
    const unknown = [...new Set(rows.flatMap(r => r.split?.length ? r.split.map(p => p.ledger) : [r.ledger]).filter(n => !k.led(n)))];
    if (unknown.length) throw new Error(`Not in Tally: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}. Create these ledgers in Tally (then ⟳ Sync from Tally) or pick existing ones.`);
    let ok = 0, bad = 0;
    for (let i = 0; i < rows.length; i += 20) {
      const part = rows.slice(i, i + 20);
      busy(true, `Posting ${Math.min(i + 20, rows.length)} of ${rows.length} to Tally…`);
      const res = await tallyImport(company, 'Vouchers', part.map(r => vxml(im, r)).join(''), k.opt());
      if (res.created === part.length && !res.errors) { for (const r of part) { r.status = 'posted'; r.msg = ''; r.postedAt = new Date().toISOString(); } ok += part.length; continue; }
      if (res.created) { // some went in – Tally does not say which, so stop here instead of risking doubles
        for (const r of part) r.status = 'check';
        bad += part.length; im.note = `Tally created ${res.created} of ${part.length} vouchers in one batch (${res.lineErrors[0] || 'error'}). Check those dates in Tally (marked “Check”), then run “Already in Tally?”.`;
        break;
      }
      for (const r of part) { // nothing created: post one by one to find the bad ones
        const r1 = await tallyImport(company, 'Vouchers', vxml(im, r), k.opt());
        if (r1.created && !r1.errors) { r.status = 'posted'; r.msg = ''; r.postedAt = new Date().toISOString(); ok++; } else { r.status = 'error'; r.msg = r1.lineErrors[0] || 'Tally did not create it'; bad++; }
      }
    }
    // remember narration words → ledger for the next statement
    const w = { ...(k.meta().words || {}) };
    for (const r of rows) if (r.status === 'posted' && r.ledger && !r.split?.length) for (const t of k.toks(r.narration).slice(0, 6)) w[t] = { type: r.type, ledger: r.ledger, n: 99 };
    await k.saveMeta({ words: w });
    return { ok, bad };
  }

  /* ---------- view ---------- */
  BI.view = () => {
    if (b().list === null) { loadList(); return '<div class="card"><p class="muted">Loading bank statements…</p></div>'; }
    const banks = L().filter(l => BANKISH.test(l.r) && !/cash-in-hand/i.test(l.r));
    const im = cur(), x = b();
    const head = `<div class="card"><div class="row-between wrap"><h2>Bank import</h2>
        <div class="btns"><select id="biBank" title="Bank ledger in Tally"><option value="">Bank ledger…</option>${banks.map(l => `<option ${l.n === (x.bank || im?.bank) ? 'selected' : ''}>${esc(l.n)}</option>`).join('')}</select>
        <label class="tf-drop bk-drop sm">+ Import statement (Excel, CSV or PDF)<input type="file" accept=".xlsx,.xls,.csv,.pdf" data-change="biFile"></label></div></div>
      ${(x.list || []).length ? `<div class="bi-stmts">${x.list.map(s => { const p = s.rows.filter(r => r.status === 'posted').length; return `<button class="${s.id === x.cur ? 'on' : ''}" data-act="biOpen" data-id="${s.id}"><b>${esc(s.bank)}</b><span>${isoToDisp(s.from)} – ${isoToDisp(s.to)} · ${p}/${s.rows.length} posted</span></button>`; }).join('')}</div>` : '<p class="muted small">Download the statement from net banking as Excel / CSV (best) or PDF, choose the bank ledger and import it. Every transaction gets its ledger filled from your rules, names in the narration and how similar entries were posted before.</p>'}</div>`;
    if (!im) return head;
    const bad = balCheck(im);
    const R = im.rows, q = (x.q || '').toLowerCase();
    const cnt = { all: R.length, todo: R.filter(r => r.status !== 'posted' && r.status !== 'dup' && missing(r)).length, set: R.filter(r => !missing(r) && r.status !== 'posted').length, out: R.filter(r => r.debit).length, in: R.filter(r => r.credit).length, dup: R.filter(r => r.status === 'dup').length, posted: R.filter(r => r.status === 'posted').length };
    const pass = r => (x.f === 'all' || (x.f === 'todo' && r.status !== 'posted' && r.status !== 'dup' && missing(r)) || (x.f === 'set' && !missing(r) && r.status !== 'posted') || (x.f === 'out' && r.debit) || (x.f === 'in' && r.credit) || (x.f === 'dup' && r.status === 'dup') || (x.f === 'posted' && r.status === 'posted'))
      && (!q || [r.narration, r.ref, r.ledger, String(amt(r))].some(v => (v || '').toLowerCase().includes(q)));
    const rows = R.filter(pass), sel = x.sel; x.shown = rows.filter(r => r.status !== 'posted').map(r => r.i);
    const tot = k => r2(R.reduce((a, r) => a + r[k], 0));
    const ready = R.filter(r => !missing(r) && !['posted', 'dup', 'check'].includes(r.status));
    return head + `<div class="card bi">
      <div class="bi-sum"><div><span>Bank</span><b>${esc(im.bank)}</b><small>${esc(im.file || '')}</small></div><div><span>Opening</span><b>${im.opening == null ? '—' : inr(im.opening)}</b></div><div><span>Withdrawals</span><b class="red">${inr(tot('debit'))}</b><small>${cnt.out} txns</small></div><div><span>Deposits</span><b class="green">${inr(tot('credit'))}</b><small>${cnt.in} txns</small></div><div><span>Closing</span><b>${im.closing == null ? '—' : inr(im.closing)}</b></div>
        <div><span>Balance check</span><b class="${bad ? 'red' : 'green'}">${im.opening == null ? 'no balance column' : bad ? `${bad} row${bad === 1 ? '' : 's'} off` : '✓ matches'}</b></div></div>
      ${im.note ? `<p class="warn small">${esc(im.note)}</p>` : ''}
      <div class="row-between wrap bi-bar"><div class="tabs-s">${FILTERS.map(([f, l]) => `<button class="${x.f === f ? 'on' : ''}" data-act="biF" data-f="${f}">${l} <b>${cnt[f]}</b></button>`).join('')}</div>
        <input id="biQ" placeholder="Search narration, amount, ledger…" value="${esc(x.q || '')}"></div>
      <div class="row-between wrap bi-bar"><div class="btns">
          <input id="biSet" list="biLeds" placeholder="Ledger for selected rows" ${sel.size ? '' : 'disabled'}><button class="sm" data-act="biSetLed" ${sel.size ? '' : 'disabled'}>Set for ${sel.size || ''} selected</button>
          <button class="sm" data-act="biRule" ${sel.size === 1 ? '' : 'disabled'} title="Always use a ledger for narrations containing a word">+ Rule from selected</button>
          <button class="sm" data-act="biAuto" title="Fill empty ledgers again from rules and past entries">⚡ Auto-fill</button><button class="sm" data-act="biRules">Rules (${(k.meta().bankRules || []).length})</button></div>
        <div class="btns"><button class="sm" data-act="biDup" title="Marks rows already entered in Tally (same date, amount and direction on this bank)">Already in Tally?</button><button class="sm" data-act="biXl">Excel</button><button class="sm danger" data-act="biDel">Delete statement</button>
          <button class="sm primary" data-act="biPost" ${ready.length ? '' : 'disabled'}>Post ${sel.size ? [...sel].filter(i => ready.some(r => r.i === i)).length + ' selected' : ready.length} to Tally</button></div></div>
      <datalist id="biLeds">${L().filter(l => l.n !== im.bank).map(l => `<option value="${esc(l.n)}">${esc(l.p)}</option>`).join('')}</datalist>
      <div class="reg-wrap"><table class="reg bi-t"><thead><tr><th><input type="checkbox" data-change="biAll" ${rows.length && rows.every(r => sel.has(r.i)) ? 'checked' : ''}></th><th>Date</th><th>Narration</th><th class="num">Withdrawal</th><th class="num">Deposit</th><th class="num">Balance</th><th>Ledger</th><th>Type</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr class="${sel.has(r.i) ? 'sel' : ''} ${r.status}">
        <td><input type="checkbox" data-change="biSel" value="${r.i}" ${sel.has(r.i) ? 'checked' : ''} ${r.status === 'posted' ? 'disabled' : ''}></td>
        <td class="nowrap">${isoToDisp(r.date)}</td>
        <td class="bi-n">${esc(r.narration)}${r.ref ? `<div class="tiny muted">Ref ${esc(r.ref)}</div>` : ''}${r.msg ? `<div class="tiny red">${esc(r.msg)}</div>` : ''}</td>
        <td class="num">${r.debit ? inr(r.debit) : ''}</td><td class="num">${r.credit ? inr(r.credit) : ''}</td>
        <td class="num ${r.balBad ? 'red' : 'muted'}" ${r.balBad ? 'title="Balance does not follow from the previous row – a row may be missing or misread"' : ''}>${r.balance == null ? '' : inr(r.balance)}</td>
        <td>${r.split?.length ? `<a href="#" data-act="biSplit" data-i="${r.i}">Split: ${r.split.length} ledgers</a>` : r.status === 'posted' ? esc(r.ledger) : `<input class="bi-l ${r.how === 'rule' ? 'rule' : r.how === 'auto' ? 'auto' : ''}" list="biLeds" value="${esc(r.ledger)}" data-change="biLed" data-i="${r.i}" placeholder="Choose ledger…" title="${r.how === 'rule' ? 'From your rule' : r.how === 'auto' ? 'Suggested – check it' : ''}">`}</td>
        <td><select class="bi-ty" data-change="biType" data-i="${r.i}" ${r.status === 'posted' ? 'disabled' : ''}>${(r.credit ? ['Receipt', 'Contra', 'Journal'] : ['Payment', 'Contra', 'Journal']).map(t => `<option ${t === r.type ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
        <td class="nowrap">${r.status === 'posted' ? '<span class="tag green">Posted</span>' : r.status === 'dup' ? '<span class="tag amber" title="Same date and amount already on this bank in Tally">In Tally</span> <a href="#" class="tiny" data-act="biUndup" data-i="' + r.i + '">not same</a>' : r.status === 'check' ? '<span class="tag red">Check</span>' : r.status === 'error' ? '<span class="tag red">Error</span>' : `<a href="#" class="tiny" data-act="biSplit" data-i="${r.i}">split</a>`}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No rows.</td></tr>'}
      </tbody></table></div>
      <p class="muted small">Green ledgers come from your rules, blue ones are suggestions (from names in the narration and how you posted similar entries before) – check them. A row to another bank or cash becomes a Contra. What you post is remembered for the next statement.</p></div>`;
  };

  /* ---------- actions ---------- */
  const rowOf = i => cur().rows.find(r => r.i === +i);
  const persist = () => save(cur());
  Object.assign(C, {
    biFile: el => { const f = el.files[0]; el.value = ''; if (!f) return; const bank = document.getElementById('biBank')?.value || cur()?.bank || '';
      guard(async () => {
        if (!bank) throw new Error('Choose the bank ledger (in Tally) for this statement first.');
        if (!k.meta().syncedAt) throw new Error('Sync from Tally first, so ledgers can be matched.');
        busy(true, `Reading ${f.name}…`);
        try {
          const got = await readFile(f);
          if (got.need) return mapCols(f, bank, got.need);
          const r = await create(f, bank, got.rows, got.how);
          render(); toast(`${r.rows} transactions imported · ledger filled for ${r.n}`, 7000);
        } finally { busy(false); }
      }); },
    biSel: el => { const s = b().sel; el.checked ? s.add(+el.value) : s.delete(+el.value); render(); },
    biAll: el => { b().sel = el.checked ? new Set(b().shown || []) : new Set(); render(); },
    biLed: el => guard(async () => { const r = rowOf(el.dataset.i); r.ledger = el.value.trim(); r.how = 'you'; r.type = typeFor(r, r.ledger); if (r.status === 'error') r.status = ''; await persist(); render(); }),
    biType: el => guard(async () => { rowOf(el.dataset.i).type = el.value; await persist(); }),
  });
  BI.onInput = el => { if (el.id === 'biQ') { b().q = el.value; render(); const i = document.getElementById('biQ'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } return true; } return false; };
  Object.assign(A, {
    biOpen: ({ id }) => { b().cur = id; b().sel = new Set(); b().f = 'all'; render(); },
    biF: ({ f }) => { b().f = f; b().sel = new Set(); render(); },
    biSetLed: () => guard(async () => { const v = document.getElementById('biSet')?.value.trim(); if (!v) throw new Error('Type or pick the ledger.'); if (!k.led(v)) throw new Error(`“${v}” is not a ledger in Tally.`);
      const im = cur(); for (const i of b().sel) { const r = rowOf(i); if (r.status === 'posted') continue; r.ledger = v; r.split = null; r.how = 'you'; r.type = typeFor(r, v); } b().sel = new Set(); await persist(); render(); }, 'Ledger set'),
    biAuto: () => guard(async () => { const n = autofill(cur()); await persist(); render(); toast(n ? `Filled ${n} more` : 'Nothing more to fill – set the rest by hand or add rules'); }),
    biRule: () => { const r = rowOf([...b().sel][0]); const words = (r.narration || '').split(/[\s\/\-:]+/).filter(w => w.length > 3 && !/^\d+$/.test(w)).slice(0, 8);
      modal(`<h2>New rule</h2><p class="small muted">Every row whose narration contains this text gets this ledger – now and in future statements.</p><p class="small"><code>${esc(r.narration)}</code></p>
        <form data-form="biRuleSave" class="grid"><label class="span2">Narration contains<input name="kw" value="${esc(words.sort((a, c) => c.length - a.length)[0] || '')}" required></label>
        <label class="span2">Ledger<input name="ledger" list="biLeds" value="${esc(r.ledger || '')}" required></label>
        <label>Applies to<select name="dir"><option value="">Withdrawals and deposits</option><option value="out" ${r.debit ? 'selected' : ''}>Withdrawals only</option><option value="in" ${r.credit ? 'selected' : ''}>Deposits only</option></select></label>
        <div class="span2 btns"><button class="primary">Save rule and apply</button><button type="button" data-act="closeModal">Cancel</button></div></form>`); },
    biRules: () => { const rs = k.meta().bankRules || [];
      modal(`<h2>Bank rules</h2>${rs.length ? `<table class="tbl"><thead><tr><th>Narration contains</th><th>Ledger</th><th>For</th><th></th></tr></thead><tbody>${rs.map((r, i) => `<tr><td><code>${esc(r.kw)}</code></td><td>${esc(r.ledger)}</td><td class="small">${r.dir === 'in' ? 'Deposits' : r.dir === 'out' ? 'Withdrawals' : 'Both'}</td><td><button class="sm danger" data-act="biRuleDel" data-n="${i}">✕</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No rules yet. Select a row and use “+ Rule from selected”.</p>'}<div class="btns mt"><button data-act="closeModal">Close</button></div>`); },
    biRuleDel: ({ n }) => guard(async () => { const rs = [...(k.meta().bankRules || [])]; rs.splice(+n, 1); await k.saveMeta({ bankRules: rs }); A.biRules(); }),
    biSplit: ({ i }) => { const r = rowOf(i), parts = r.split?.length ? r.split : [{ ledger: r.ledger, amount: amt(r) }, { ledger: '', amount: 0 }];
      modal(`<h2>Split ${inr(amt(r))}</h2><p class="small"><code>${esc(r.narration)}</code></p><form data-form="biSplitSave" data-i="${r.i}"><div id="biParts">${parts.map(p => `<div class="bs-row"><input name="sl" list="biLeds" value="${esc(p.ledger)}" placeholder="Ledger"><input name="sa" type="number" step="0.01" value="${p.amount || ''}" placeholder="Amount"></div>`).join('')}</div>
        <button type="button" class="sm" data-act="biAddPart">+ Add line</button><p class="small muted">The amounts must add up to ${inr(amt(r))}.</p>
        <div class="btns"><button class="primary">Save split</button>${r.split?.length ? '<button type="button" class="danger" data-act="biUnsplit" data-i="' + r.i + '">Remove split</button>' : ''}<button type="button" data-act="closeModal">Cancel</button></div></form>`); },
    biAddPart: () => document.getElementById('biParts')?.insertAdjacentHTML('beforeend', '<div class="bs-row"><input name="sl" list="biLeds" placeholder="Ledger"><input name="sa" type="number" step="0.01" placeholder="Amount"></div>'),
    biUnsplit: ({ i }) => guard(async () => { const r = rowOf(i); r.split = null; await persist(); closeModal(); render(); }),
    biUndup: ({ i }) => guard(async () => { rowOf(i).status = ''; await persist(); render(); }),
    biDup: () => guard(async () => { const n = await checkTally(cur()).finally(() => busy(false)); await persist(); render(); toast(n ? `${n} row${n === 1 ? '' : 's'} already in Tally – they will not be posted` : 'None of these rows is in Tally yet', 7000); }),
    biPost: () => { const im = cur(), sel = b().sel;
      const rows = im.rows.filter(r => !missing(r) && !['posted', 'dup', 'check'].includes(r.status) && (!sel.size || sel.has(r.i)));
      if (!rows.length) return;
      if (!confirm(`Post ${rows.length} voucher${rows.length === 1 ? '' : 's'} on ${im.bank} to Tally company “${k.meta().company}”?\n\nRows marked “In Tally” are skipped. Tip: run “Already in Tally?” first.`)) return;
      guard(async () => { const r = await post(im, rows).finally(() => busy(false)); b().sel = new Set(); await persist(); render(); toast(`${r.ok} posted to Tally${r.bad ? ` · ${r.bad} not posted – see the red rows` : ''}`, 8000); }); },
    biDel: () => { const im = cur(); if (!confirm(`Delete the imported statement ${im.bank} ${isoToDisp(im.from)} – ${isoToDisp(im.to)} from CA Desk? (Vouchers already posted stay in Tally.)`)) return;
      guard(async () => { await deleteDoc(doc(db, 'clients', k.st().cid, 'bankimports', im.id)); b().list = b().list.filter(x => x.id !== im.id); b().cur = b().list[0]?.id || null; render(); }, 'Deleted'); },
    biXl: () => { const im = cur(); const ws = XLSX.utils.aoa_to_sheet([['Date', 'Narration', 'Reference', 'Withdrawal', 'Deposit', 'Balance', 'Ledger', 'Voucher type', 'Status'], ...im.rows.map(r => [r.date, r.narration, r.ref, r.debit || '', r.credit || '', r.balance ?? '', r.split?.length ? r.split.map(p => `${p.ledger}: ${p.amount}`).join('; ') : r.ledger, r.type, r.status || ''])]);
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Bank'); XLSX.writeFile(wb, `Bank ${im.bank} ${im.from} to ${im.to}.xlsx`); },
  });
  Object.assign(F, {
    biRuleSave: fd => guard(async () => { const rule = { kw: String(fd.get('kw')).trim(), ledger: String(fd.get('ledger')).trim(), dir: fd.get('dir') || '' };
      if (!k.led(rule.ledger)) throw new Error(`“${rule.ledger}” is not a ledger in Tally.`);
      await k.saveMeta({ bankRules: [rule, ...(k.meta().bankRules || []).filter(r => r.kw.toUpperCase() !== rule.kw.toUpperCase())] });
      const im = cur(); let n = 0; for (const r of im.rows) { if (r.status === 'posted' || r.how === 'you' && !b().sel.has(r.i)) continue; if (r.narration.toUpperCase().includes(rule.kw.toUpperCase()) && (!rule.dir || rule.dir === (r.credit ? 'in' : 'out'))) { r.ledger = rule.ledger; r.split = null; r.how = 'rule'; r.type = typeFor(r, rule.ledger); n++; } }
      b().sel = new Set(); await persist(); closeModal(); render(); toast(`Rule saved · applied to ${n} row${n === 1 ? '' : 's'}`); }),
    biSplitSave: (fd, form) => guard(async () => { const r = rowOf(form.dataset.i), ls = fd.getAll('sl'), as = fd.getAll('sa');
      const parts = ls.map((l, j) => ({ ledger: l.trim(), amount: r2(as[j]) })).filter(p => p.ledger || p.amount);
      if (parts.length < 2) throw new Error('A split needs at least two lines.');
      const bad = parts.find(p => !k.led(p.ledger)); if (bad) throw new Error(`“${bad.ledger || '(blank)'}” is not a ledger in Tally.`);
      const sum = r2(parts.reduce((a, p) => a + p.amount, 0)); if (Math.abs(sum - amt(r)) > 0.01) throw new Error(`The lines add up to ${inr(sum)}, not ${inr(amt(r))}.`);
      r.split = parts; r.ledger = parts[0].ledger; r.how = 'you'; r.type = typeFor(r, parts[0].ledger); await persist(); closeModal(); render(); }, 'Split saved'),
    biMapSave: (fd, form) => guard(async () => { const st = BI._map; const col = {}; for (const kk of ['date', 'narr', 'ref', 'debit', 'credit', 'amt', 'drcr', 'bal']) { const v = fd.get(kk); if (v !== '' && v != null) col[kk] = +v; }
      if (col.date == null || (col.debit == null && col.credit == null && col.amt == null)) throw new Error('Choose at least the date column and the amount column(s).');
      const rows = rowsFromSheet(st.rows, { head: +fd.get('head'), col }); closeModal(); busy(true, 'Importing…');
      try { const r = await create(st.file, st.bank, rows, 'Excel (columns chosen)'); render(); toast(`${r.rows} transactions imported · ledger filled for ${r.n}`, 7000); } finally { busy(false); } }),
  });
  function mapCols(file, bank, rows) {
    BI._map = { file, bank, rows };
    const hi = rows.findIndex(r => (r || []).filter(x => String(x).trim()).length >= 4); const h = (rows[hi] || []).map(x => String(x ?? ''));
    const sel = (n, l) => `<label>${l}<select name="${n}"><option value="">—</option>${h.map((x, j) => `<option value="${j}">${esc(x || 'Column ' + (j + 1))}</option>`).join('')}</select></label>`;
    modal(`<h2>Which column is which?</h2><p class="small muted">${esc(file.name)} – the header row could not be recognised. Pick the columns once.</p>
      <form data-form="biMapSave" class="grid"><label>Header row number<input name="head" type="number" value="${hi < 0 ? 0 : hi}" min="0"></label><label></label>
      ${sel('date', 'Date')}${sel('narr', 'Narration')}${sel('ref', 'Cheque / reference')}${sel('bal', 'Balance')}${sel('debit', 'Withdrawal (debit)')}${sel('credit', 'Deposit (credit)')}${sel('amt', 'or: one Amount column')}${sel('drcr', 'and its Dr / Cr column')}
      <div class="span2 btns"><button class="primary">Import</button><button type="button" data-act="closeModal">Cancel</button></div></form>`);
  }
  BI.reset = () => { k.st().bi = null; };
  return BI;
}
