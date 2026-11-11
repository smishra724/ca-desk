// Fetch GSTR-1 data from TallyPrime / Tally.ERP 9 over its ODBC / HTTP port (default 9000) and build the
// GST portal JSON (b2b, b2cl, b2cs, cdnr, cdnur, nil, hsn_b2b/hsn_b2c, doc_issue).
// The page calls Tally directly (Chrome asks once to allow access to apps on this computer). If the CA Desk Helper
// extension happens to be installed it is used instead. When neither works, a Day Book XML exported from Tally
// can be browsed and is converted the same way.
import { STATE_CODES } from './extract.js';

const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const STATE_BY_NAME = Object.fromEntries(Object.entries(STATE_CODES).map(([c, n]) => [norm(n), c]));
Object.assign(STATE_BY_NAME, { delhi: '07', newdelhi: '07', nctofdelhi: '07', orissa: '21', pondicherry: '34', uttaranchal: '05', jammuandkashmir: '01', jammukashmir: '01',
  dadraandnagarhaveli: '26', damananddiu: '26', andamanandnicobar: '35', otherterritory: '97', other: '96', othercountries: '96', othercountry: '96', outsideindia: '96', foreigncountry: '96', foreign: '96' });
const stateCode = name => STATE_BY_NAME[norm(name)] || '';
const RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];
const snap = r => RATES.reduce((a, b) => Math.abs(b - r) < Math.abs(a - r) ? b : a, 0);
const r2 = v => Math.round(v * 100) / 100;
const UQC = { nos: 'NOS', no: 'NOS', number: 'NOS', numbers: 'NOS', pcs: 'PCS', pc: 'PCS', piece: 'PCS', pieces: 'PCS', kgs: 'KGS', kg: 'KGS', kilogram: 'KGS', kilograms: 'KGS', gms: 'GMS', gm: 'GMS', g: 'GMS', grams: 'GMS',
  ltr: 'LTR', ltrs: 'LTR', litre: 'LTR', litres: 'LTR', l: 'LTR', mtr: 'MTR', mtrs: 'MTR', meter: 'MTR', metre: 'MTR', mts: 'MTR', box: 'BOX', boxes: 'BOX', set: 'SET', sets: 'SET', pac: 'PAC', pack: 'PAC', pkt: 'PAC', pairs: 'PRS', pair: 'PRS', prs: 'PRS',
  dozen: 'DOZ', doz: 'DOZ', ton: 'TON', tons: 'TON', mt: 'MTS', qtl: 'QTL', bag: 'BAG', bags: 'BAG', btl: 'BTL', bottle: 'BTL', can: 'CAN', ctn: 'CTN', carton: 'CTN', roll: 'ROL', rolls: 'ROL', sqf: 'SQF', sqft: 'SQF', sqm: 'SQM', unit: 'UNT', units: 'UNT', ml: 'MLT', mlt: 'MLT' };

/* ---------- talking to Tally ---------- */
let seq = 0;
export const tallyViaExtension = () => document.documentElement.dataset.capmTally === '1';
export async function tallyPost(xml, { host = 'localhost', port = 9000 } = {}) {
  const url = `http://${host}:${port}`;
  if (tallyViaExtension()) {
    const id = `t${Date.now()}${++seq}`;
    return new Promise((ok, bad) => {
      const to = setTimeout(() => { window.removeEventListener('message', on); bad(new Error('Tally did not answer in 2 minutes.')); }, 120000);
      function on(e) {
        if (e.source !== window || e.data?.type !== 'CAPM_TALLY_RES' || e.data.id !== id) return;
        clearTimeout(to); window.removeEventListener('message', on);
        e.data.ok ? ok(e.data.text) : bad(new Error(notReachable(port, e.data.error)));
      }
      window.addEventListener('message', on);
      window.postMessage({ type: 'CAPM_TALLY', id, url, xml }, location.origin);
    });
  }
  let r;
  try { r = await fetch(url, { method: 'POST', body: xml, cache: 'no-store', targetAddressSpace: 'loopback' }); } // plain-text body → no CORS pre-check
  catch {
    // Find out why: if a blind (no-cors) request gets through, Tally is running but does not let web pages read its reply
    let alive = false;
    for (const h of [host, host === 'localhost' ? '127.0.0.1' : 'localhost']) {
      try { await fetch(`http://${h}:${port}`, { method: 'POST', body: '<ENVELOPE></ENVELOPE>', mode: 'no-cors', targetAddressSpace: 'loopback' }); alive = true; break; } catch { /* not listening / blocked */ }
    }
    throw new Error(alive ? CORS(port) : BLOCKED(port));
  }
  return decode(await r.arrayBuffer());
}
export const CORS = port => `Tally is running on port ${port}, but it does not allow web pages to read its data, so Chrome blocks the reply. Use “Can’t connect? Use a Tally XML file instead” below (Day Book → Alt+E → XML), or install the CA Desk Helper extension, which is allowed to read from Tally.`;
export const BLOCKED = port => `Nothing is answering on port ${port} of this computer. Check that Tally is open on this same computer (not on a remote desktop or server) with the company loaded, and its port is on (F1 Help → Settings → Connectivity → Client/Server configuration: TallyPrime acts as “Both”, Enable ODBC “Yes”, Port ${port}). If Chrome asked to allow access to apps on this computer, choose Allow. Or export the Day Book from Tally as XML and use “Tally XML file”.`;
const decode = b => { const u8 = new Uint8Array(b); if (u8[0] === 0xFF && u8[1] === 0xFE || (u8.length > 1 && u8[1] === 0)) return new TextDecoder('utf-16le').decode(b); return new TextDecoder('utf-8').decode(b); };
export const readTallyFile = async f => decode(await f.arrayBuffer());
const notReachable = (port, err) => `Tally is not answering on port ${port}${err ? ` (${err})` : ''}. Open TallyPrime with the company loaded, and check F1 Help → Settings → Connectivity → Client/Server configuration: TallyPrime acts as “Both” (or Server), Enable ODBC “Yes”, Port ${port}.`;

export const tallyLast = { text: '', step: '' };
function parseXml(text, step = '') {
  tallyLast.text = String(text); tallyLast.step = step;
  const bad = c => (c < 32 && ![9, 10, 13].includes(c)) || (c >= 0xFFFE && c <= 0xFFFF) || (c >= 0xD800 && c <= 0xDFFF);
  let clean = String(text)
    .replace(/^\uFEFF/, '').replace(/<\?xml[^>]*\?>/i, '')                       // stray BOM / wrong encoding declaration
    .replace(/&#(\d+);/g, (m, n) => bad(+n) ? '' : m)                          // control characters Tally writes as &#4; etc.
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => bad(parseInt(h, 16)) ? '' : m)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '')
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')      // bare & in names / narrations
    .replace(/<(\/?)([A-Za-z_][\w.-]*):(?=[A-Za-z_])/g, '<$1$2_')                // Tally's UDF:… tags (undeclared prefix) → UDF_…
    .replace(/\s([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)=/g, ' $1_$2=');
  let d = new DOMParser().parseFromString(clean, 'text/xml');
  if (d.querySelector('parsererror')) { // last resort: wrap in a root (Tally sometimes sends several top-level blocks)
    const d2 = new DOMParser().parseFromString(`<CADESKROOT>${clean.replace(/<!DOCTYPE[^>]*>/i, '')}</CADESKROOT>`, 'text/xml');
    if (!d2.querySelector('parsererror')) d = d2;
  }
  if (d.querySelector('parsererror')) {
    const pe = d.querySelector('parsererror').textContent || '', m = pe.match(/line\s*(\d+)[^0-9]+(\d+)/i);
    let near = '';
    if (m) { const ln = clean.split('\n')[+m[1] - 1] || ''; near = ln.slice(Math.max(0, +m[2] - 60), +m[2] + 40).trim(); }
    const empty = !clean.trim();
    throw new Error(empty ? `Tally sent an empty reply${step ? ` (${step})` : ''}. Check that the company is open in Tally and try again.`
      : `Tally sent a reply that could not be read${step ? ` (${step})` : ''}${m ? ` — problem at line ${m[1]}${near ? `, near “${near}”` : ''}` : ''}. Use “Download Tally’s reply” and send it to support, or use the Tally XML file option.`);
  }
  const err = d.querySelector('LINEERROR')?.textContent;
  if (err) throw new Error(`Tally: ${err.trim()}`);
  return d;
}
const env = (id, body, vars = '') => `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${vars}</STATICVARIABLES><TDL><TDLMESSAGE>${body}</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
const xesc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const kids = (el, tag) => [...(el?.children || [])].filter(c => c.tagName === tag);
const kid = (el, tag) => kids(el, tag)[0];
const txt = (el, tag) => (kid(el, tag)?.textContent || '').trim();
// Amounts: "-450332.27", "-1,23,456.00", or forex like "-$5000.00 @ ₹ 90.07/$ = -₹ 450332.27" (take the rupee part)
const amt = s => { s = String(s || ''); if (s.includes('=')) s = s.slice(s.lastIndexOf('=') + 1); const neg = /-/.test(s); const v = parseFloat(s.replace(/[^0-9.]/g, '')) || 0; return neg ? -v : v; };
const num = (el, tag) => amt(txt(el, tag));
const deepTxt = (el, tags) => { for (const t of tags) { const x = el.getElementsByTagName(t)[0]?.textContent.trim(); if (x) return x; } return ''; };
const deep = (el, tag) => [...(el?.getElementsByTagName(tag) || [])];
const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/;

export async function tallyCompanies(opt) {
  const d = parseXml(await tallyPost(env('CADeskCmp', '<COLLECTION NAME="CADeskCmp" ISMODIFY="No"><TYPE>Company</TYPE><FETCH>Name,StartingFrom,BooksFrom</FETCH></COLLECTION>'), opt));
  const list = deep(d, 'COMPANY').map(c => ({ name: c.getAttribute('NAME') || txt(c, 'NAME'), gstin: (c.textContent.toUpperCase().match(GSTIN_RE) || [])[0] || '' })).filter(c => c.name);
  if (!list.length) throw new Error('No company is open in Tally. Open (load) the client’s company in Tally and try again.');
  return list;
}

// Rate (IGST-equivalent %) and HSN from any GST details block inside a master or entry
function rateIn(el) {
  let ig = 0, cg = 0, sg = 0, any = false;
  for (const rd of deep(el, 'RATEDETAILS.LIST')) {
    const head = txt(rd, 'GSTRATEDUTYHEAD').toLowerCase(), r = num(rd, 'GSTRATE');
    if (!head) continue; any = true;
    if (/igst|integrated/.test(head)) ig = r; else if (/cgst|central/.test(head)) cg = r; else if (/sgst|utgst|state/.test(head)) sg = r;
  }
  return any ? (ig || cg + sg) : null;
}
const hsnIn = el => (deep(el, 'GSTHSNNAME')[0] || deep(el, 'HSNCODE').filter(x => x.textContent.trim()).pop() || deep(el, 'HSN')[0])?.textContent.trim() || '';

async function masters(company, opt) {
  const vars = `<SVCURRENTCOMPANY>${xesc(company)}</SVCURRENTCOMPANY>`;
  const L = {}, I = {};
  let ld;
  try { ld = parseXml(await tallyPost(env('CADeskLed', '<COLLECTION NAME="CADeskLed" ISMODIFY="No"><TYPE>Ledger</TYPE><FETCH>Name,Parent,TaxType,GSTDutyHead,GSTDetails,LedStateName,PartyGSTIN,CountryName,GSTRegistrationType</FETCH></COLLECTION>', vars), opt), 'ledgers'); }
  catch (e) { if (!/could not be read/.test(e.message)) throw e; ld = parseXml(await tallyPost(env('CADeskLed', '<COLLECTION NAME="CADeskLed" ISMODIFY="No"><TYPE>Ledger</TYPE><FETCH>Name,Parent,TaxType,GSTDutyHead,LedStateName,PartyGSTIN,CountryName</FETCH></COLLECTION>', vars), opt), 'ledgers'); }
  for (const l of deep(ld, 'LEDGER')) {
    const name = l.getAttribute('NAME') || txt(l, 'NAME');
    L[name] = { parent: txt(l, 'PARENT'), taxType: txt(l, 'TAXTYPE'), duty: txt(l, 'GSTDUTYHEAD'), rate: rateIn(l), hsn: hsnIn(l),
      state: txt(l, 'LEDSTATENAME'), gstin: txt(l, 'PARTYGSTIN'), country: txt(l, 'COUNTRYNAME'), regType: txt(l, 'GSTREGISTRATIONTYPE') };
  }
  try {
    const sd = parseXml(await tallyPost(env('CADeskItm', '<COLLECTION NAME="CADeskItm" ISMODIFY="No"><TYPE>StockItem</TYPE><FETCH>Name,BaseUnits,GSTDetails,Description</FETCH></COLLECTION>', vars), opt));
    for (const s of deep(sd, 'STOCKITEM')) I[s.getAttribute('NAME') || txt(s, 'NAME')] = { unit: txt(s, 'BASEUNITS'), rate: rateIn(s), hsn: hsnIn(s), desc: txt(s, 'DESCRIPTION') };
  } catch { /* accounts-only company */ }
  return { L, I };
}

const dutyOf = (name, L) => {
  const m = L[name];
  const h = (m ? `${m.duty} ${/duties|tax/i.test(m.parent) || /gst/i.test(m.taxType) ? name : ''}` : /gst|cess/i.test(name) ? name : '').toLowerCase();
  if (/cess/.test(h)) return 'csamt';
  if (/igst|integrated/.test(h)) return 'iamt';
  if (/cgst|central/.test(h)) return 'camt';
  if (/sgst|utgst|state tax|ut tax/.test(h)) return 'samt';
  return '';
};

/* ---------- vouchers → GSTR-1 JSON ---------- */
// quarterly = QRMP GSTR-1 (covers the quarter ending in fp, B2B invoices already in IFF are left out by the caller's review)
export async function fetchGstr1({ company, gstin, fp, iff = false, quarterly = false, b2bFrom = '' }, opt, onStep = () => {}) {
  const y = +fp.slice(2), m = +fp.slice(0, 2);
  const start = new Date(y, quarterly ? m - 3 : m - 1, 1), end = new Date(y, m, 0);
  const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  onStep('Reading ledgers and stock items from Tally…');
  const { L, I } = await masters(company, opt);
  onStep('Reading sales, credit notes and debit notes…');
  const vars = `<SVCURRENTCOMPANY>${xesc(company)}</SVCURRENTCOMPANY><SVFROMDATE>${ymd(start)}</SVFROMDATE><SVTODATE>${ymd(end)}</SVTODATE>`;
  const body = f => `<COLLECTION NAME="CADeskVch" ISMODIFY="No"><TYPE>Voucher</TYPE><FETCH>${f}</FETCH><FILTER>CADeskGST,CADeskDt</FILTER></COLLECTION>
    <SYSTEM TYPE="Formulae" NAME="CADeskGST">$$IsSales:$VoucherTypeName OR $$IsCreditNote:$VoucherTypeName OR $$IsDebitNote:$VoucherTypeName</SYSTEM>
    <SYSTEM TYPE="Formulae" NAME="CADeskDt">$Date &gt;= $$Date:"${start.getDate()}-${start.toLocaleString('en', { month: 'short' })}-${start.getFullYear()}" AND $Date &lt;= $$Date:"${end.getDate()}-${end.toLocaleString('en', { month: 'short' })}-${end.getFullYear()}"</SYSTEM>`;
  const base = 'Date,VoucherNumber,VoucherTypeName,PartyLedgerName,PartyGSTIN,PlaceOfSupply,StateName,CountryOfResidence,IsCancelled,IsOptional,IsDeleted,Reference,AllLedgerEntries,AllInventoryEntries';
  const extra = ',CmpGSTIN,GSTRegistrationType,ShippingBillNo,ShippingBillDate,PortCode';
  let d;
  for (const f of [base + extra, base + ',CmpGSTIN,GSTRegistrationType', base]) {
    try { d = parseXml(await tallyPost(env('CADeskVch', body(f), vars), opt), 'vouchers'); break; }
    catch (e) { if (!/^Tally:|could not be read/.test(e.message) || f === base) throw e; }
  }
  return build(deep(d, 'VOUCHER'), { gstin, fp, iff, L, I, start, end, b2bFrom });
}

// From XML exported out of Tally (Day Book / vouchers, optionally masters) — no connection needed
export function gstr1FromXml(texts, { gstin, fp, iff = false, quarterly = false, b2bFrom = '' }) {
  const y = +fp.slice(2), m = +fp.slice(0, 2);
  const start = new Date(y, quarterly ? m - 3 : m - 1, 1), end = new Date(y, m, 0);
  const L = {}, I = {}, vch = [];
  for (const t of texts) {
    const d = parseXml(t);
    for (const l of deep(d, 'LEDGER')) { const name = l.getAttribute('NAME') || txt(l, 'NAME'); if (name) L[name] = { parent: txt(l, 'PARENT'), taxType: txt(l, 'TAXTYPE'), duty: txt(l, 'GSTDUTYHEAD'), rate: rateIn(l), hsn: hsnIn(l), state: txt(l, 'LEDSTATENAME'), gstin: txt(l, 'PARTYGSTIN'), country: txt(l, 'COUNTRYNAME'), regType: txt(l, 'GSTREGISTRATIONTYPE') }; }
    for (const it of deep(d, 'STOCKITEM')) { const name = it.getAttribute('NAME') || txt(it, 'NAME'); if (name) I[name] = { unit: txt(it, 'BASEUNITS'), rate: rateIn(it), hsn: hsnIn(it), desc: txt(it, 'DESCRIPTION') }; }
    for (const v of deep(d, 'VOUCHER')) { const vt = txt(v, 'VOUCHERTYPENAME') || v.getAttribute('VCHTYPE') || ''; if (/sales|credit|debit/i.test(vt) || /sales|credit|debit/i.test(v.getAttribute('OBJVIEW') || '')) vch.push(v); }
  }
  if (!vch.length) throw new Error('No sales, credit note or debit note vouchers found in this file. In Tally open Day Book for the period → Export (Alt+E) → Format: XML (Data Interchange).');
  return build(vch, { gstin, fp, iff, L, I, start, end, b2bFrom });
}

const GCH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gstinValid = g => { if (!/^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/.test(g || '')) return false; let sum = 0; for (let i = 0; i < 14; i++) { const v = GCH.indexOf(g[i]) * (i % 2 ? 2 : 1); sum += Math.floor(v / 36) + (v % 36); } return GCH[(36 - (sum % 36)) % 36] === g[14]; };
const STD = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];

function build(vchs, { gstin, fp, iff, L, I, start, end, b2bFrom }) {
  const own = gstin.slice(0, 2), warns = [], seen = new Set(), issues = [], vmap = {}, partyDone = new Set();
  let cur = {};
  // a problem the GST portal is likely to reject (err) or that needs a look (warn), tied to the Tally voucher
  const iss = (sev, msg, fix = '', ctx = cur) => issues.push({ sev, vch: ctx.no || '', vt: ctx.vt || '', date: ctx.date || '', party: ctx.party || '', msg, fix });
  const noHsn = [], names = {}, exp = {}, b2b = {}, b2cl = {}, b2cs = {}, cdnr = {}, cdnur = [], nil = {}, hsn = { b2b: {}, b2c: {} }, docs = { 1: [], 4: [], 5: [] }, cancelled = { 1: [], 4: [], 5: [] };
  let used = 0;
  const dmy = s => `${s.slice(6, 8)}-${s.slice(4, 6)}-${s.slice(0, 4)}`;
  for (const v of vchs) {
    const vt = txt(v, 'VOUCHERTYPENAME') || v.getAttribute('VCHTYPE') || '';
    const kind = /credit/i.test(vt) ? 'C' : /debit/i.test(vt) ? 'D' : 'S';
    const no = txt(v, 'VOUCHERNUMBER'), dt = txt(v, 'DATE');
    const docNum = kind === 'S' ? 1 : kind === 'D' ? 4 : 5;
    if (!dt || dt < `${start.getFullYear()}${String(start.getMonth() + 1).padStart(2, '0')}01` || dt > `${end.getFullYear()}${String(end.getMonth() + 1).padStart(2, '0')}${String(end.getDate()).padStart(2, '0')}`) continue;
    const cmp = txt(v, 'CMPGSTIN'); if (cmp && cmp !== gstin) continue; // another GST registration in the same Tally company
    if (txt(v, 'ISOPTIONAL') === 'Yes' || txt(v, 'ISDELETED') === 'Yes') continue;
    if (txt(v, 'ISCANCELLED') === 'Yes') { if (no) cancelled[docNum].push(no); continue; }
    const key = `${vt}|${no}`; if (seen.has(key)) continue; seen.add(key);
    const party = txt(v, 'PARTYLEDGERNAME'), pm = L[party] || {};
    cur = { no, vt, date: dmy(dt), party }; vmap[no] = cur;
    const ctin = (txt(v, 'PARTYGSTIN') || pm.gstin || '').toUpperCase();
    let pos = stateCode(txt(v, 'PLACEOFSUPPLY')) || (ctin ? ctin.slice(0, 2) : '') || stateCode(txt(v, 'STATENAME')) || stateCode(pm.state) || own;
    const country = txt(v, 'COUNTRYOFRESIDENCE') || pm.country;
    const regType = txt(v, 'GSTREGISTRATIONTYPE') || pm.regType || '';
    const sez = /sez/i.test(regType) && !!ctin;
    if (ctin && !gstinValid(ctin) && !partyDone.has(party + 'g')) { partyDone.add(party + 'g'); iss('err', `Party GSTIN ${ctin} is not a valid GSTIN (check digit fails).`, `Alter ledger “${party}” → GST registration details → correct the GSTIN.`); }
    if (ctin && ctin === gstin) iss('err', 'Party GSTIN is the client’s own GSTIN.', `Alter ledger “${party}” → GSTIN.`);
    if (!ctin && /regular|composition|sez/i.test(regType) && !partyDone.has(party + 'r')) { partyDone.add(party + 'r'); iss('warn', `Party is marked “${regType}” in Tally but has no GSTIN — it is reported as B2C.`, `Alter ledger “${party}” → add the GSTIN, or set registration type to Unregistered.`); }
    if (no && (!/^[A-Za-z0-9\/-]{1,16}$/.test(no) || /^[0\/-]+$/.test(no))) iss('err', `Invoice number “${no}” is not accepted by the portal (only letters, digits, / and -, max 16, not all zeros).`, 'Change the voucher number (or the voucher type’s prefix/suffix numbering) so it has no spaces or other symbols.');
    // accounting lines
    // Tally can send the same lines twice (ALL… and plain lists) — use one of them, never both
    const pickList = (all, plain) => { const a = kids(v, all); return a.length ? a : kids(v, plain); };
    const inv = pickList('ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIES.LIST');
    const allocNames = new Set(inv.flatMap(i => deep(i, 'LEDGERNAME').map(x => x.textContent.trim())));
    const led = pickList('ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST');
    const tax = { iamt: 0, camt: 0, samt: 0, csamt: 0 }; let val = 0, rnd = 0; const lines = [];
    for (const e of led) {
      const n = txt(e, 'LEDGERNAME'), a = num(e, 'AMOUNT');
      if (n === party) { val += Math.abs(a); continue; }
      const h = dutyOf(n, L); if (h) { tax[h] += a; continue; }
      if (/round/i.test(n)) { rnd += a; continue; }
      if (allocNames.has(n)) continue;
      const lm = L[n] || {};
      if (/sundry|bank|cash/i.test(lm.parent)) continue;
      lines.push({ amt: a, rate: rateIn(e) ?? lm.rate, hsn: hsnIn(e) || lm.hsn, qty: 0, unit: '', desc: n, led: n });
    }
    for (const it of inv) {
      const n = txt(it, 'STOCKITEMNAME'), im = I[n] || {}, a = num(it, 'AMOUNT');
      const q = txt(it, 'BILLEDQTY') || txt(it, 'ACTUALQTY'), qn = Math.abs(parseFloat(q.replace(/[^0-9.\-]/g, '')) || 0), u = (q.replace(/[0-9.,\-\s]+/, '').trim().split(/\s|=/)[0]) || im.unit;
      const allocLed = deep(it, 'LEDGERNAME')[0]?.textContent.trim(), am = L[allocLed] || {};
      lines.push({ amt: a, rate: rateIn(it) ?? im.rate ?? am.rate, hsn: hsnIn(it) || im.hsn || am.hsn, qty: qn, unit: u, desc: im.desc || n, led: allocLed || '' });
    }
    let txval = Math.abs(lines.reduce((s, l) => s + l.amt, 0));
    for (const k in tax) tax[k] = Math.abs(tax[k]);
    const taxTot = tax.iamt + tax.camt + tax.samt;
    if (!txval && !taxTot) continue;
    if (!val) val = txval + taxTot + tax.csamt;
    else if (Math.abs(val - (txval + taxTot + tax.csamt + Math.abs(rnd))) > 1 && Math.abs(val - (txval + taxTot + tax.csamt - Math.abs(rnd))) > 1) iss('warn', `Taxable value + tax (₹${r2(txval + taxTot + tax.csamt)}) does not add up to the invoice total (₹${r2(val)}).`, 'Open the voucher — a ledger may be missing its GST classification, or an expense/discount line is not marked as part of taxable value.');
    if (Math.abs(rnd) > 1) iss('warn', `Round-off of ₹${r2(Math.abs(rnd))} is more than ₹1.`, 'Check the round-off line in the voucher.');
    if (tax.camt + tax.samt > 0 && tax.iamt > 0) iss('err', 'Both IGST and CGST/SGST are charged on the same invoice.', 'Keep either IGST (other state) or CGST + SGST (same state).');
    else if (pos !== own && pos !== '96' && tax.camt + tax.samt > 0) iss('err', `Place of supply is ${pos} (another state) but CGST + SGST is charged — the portal needs IGST.`, `Check the State / Place of Supply of “${party}”; if the sale is inter-state, use the IGST ledger.`);
    else if (pos === own && tax.iamt > 0 && !sez) iss('err', `Place of supply is the client’s own state but IGST is charged — the portal needs CGST + SGST.`, `Check the State / Place of Supply of “${party}”; if it is an intra-state sale, use CGST + SGST ledgers.`);
    if (Math.abs(tax.camt - tax.samt) > 0.5) iss('err', `CGST (₹${r2(tax.camt)}) and SGST (₹${r2(tax.samt)}) are not equal.`, 'Correct the CGST/SGST amounts in the voucher.');
    if (txval && taxTot) { const er = taxTot / txval * 100; if (!STD.some(r => Math.abs(r - er) < 0.06) && !lines.some(l => l.rate != null && l.rate !== snap(er))) iss('err', `Tax charged is ${r2(er)}% of taxable value — not a GST rate.`, 'Check the tax amounts or the taxable value in this voucher (a ledger may be missing GST, or tax is overwritten).'); }
    if (!taxTot && lines.some(l => (l.rate || 0) > 0) && kind === 'S' && !sez && !lines.some(l => /\bexports?\b|\blut\b/i.test(l.led || ''))) iss('err', `No GST charged although the item/ledger GST rate is ${lines.find(l => l.rate > 0).rate}%.`, 'Add the GST ledgers to the voucher, or correct the GST rate on the item/ledger if it is really exempt.');
    if (!val && !txval) iss('warn', 'Invoice value is 0.', 'Delete or cancel the voucher if it is not a real sale.');
    used++; if (no) docs[docNum].push(no);
    const exportSale = !ctin && ((country && !/india/i.test(country)) || pos === '96' || lines.some(l => /\bexports?\b|\blut\b|\boverseas\b|\bforeign\b|zero[\s-]?rated/i.test(l.led || ''))); // sales ledger names only — not item names like CLUTCH
    if (exportSale) pos = '96';
    if (!txt(v, 'PLACEOFSUPPLY') && !ctin && !txt(v, 'STATENAME') && !pm.state && kind === 'S' && !exportSale) iss('warn', `No place of supply or party state — taken as the client’s own state (${own}).`, `Set the State in ledger “${party}” or Place of Supply in the voucher (party details).`);
    const inter = tax.iamt > 0 || (!(tax.camt + tax.samt) && pos !== own);
    // split taxable by rate: item rates from Tally where known, otherwise the invoice's effective rate
    const eff = txval ? snap(taxTot / txval * 100) : 0;
    const byRate = {};
    for (const l of lines) { const r = l.rate != null ? snap(l.rate) : eff; byRate[r] = (byRate[r] || 0) + Math.abs(l.amt); }
    const rates = Object.keys(byRate).map(Number);
    const items = rates.map((rt, i) => {
      const tv = r2(byRate[rt]);
      if (rates.length === 1) return { rt, txval: r2(txval), iamt: r2(tax.iamt), camt: r2(tax.camt), samt: r2(tax.samt), csamt: r2(tax.csamt) };
      const t = tv * rt / 100, share = txval ? tv / txval : 0;
      return { rt, txval: tv, iamt: inter ? r2(t) : 0, camt: inter ? 0 : r2(t / 2), samt: inter ? 0 : r2(t / 2), csamt: r2(tax.csamt * share) };
    });
    if (rates.length === 1 && rates[0] !== eff && txval) warns.push(`${vt} ${no}: tax charged (${r2(taxTot / txval * 100)}%) differs from the GST rate in Tally (${rates[0]}%). Check this invoice.`);
    const sign = kind === 'C' ? -1 : 1;
    // HSN summary (credit notes reduce it)
    const hb = ctin ? hsn.b2b : hsn.b2c;
    for (const l of lines) {
      const r = l.rate != null ? snap(l.rate) : eff, k = `${l.hsn}|${r}|${UQC[norm(l.unit)] || (l.qty ? 'OTH' : 'NA')}`;
      if (!l.hsn) { noHsn.push(l.desc); if (!partyDone.has('h' + l.desc)) { partyDone.add('h' + l.desc); iss('err', `No HSN/SAC on “${l.desc}”.`, `Alter ${l.qty ? 'stock item' : 'ledger'} “${l.desc}” → GST details → HSN/SAC.`); } }
      else if (!/^\d{4}$|^\d{6}$|^\d{8}$/.test(l.hsn) && !partyDone.has('hb' + l.desc)) { partyDone.add('hb' + l.desc); iss('err', `HSN/SAC “${l.hsn}” on “${l.desc}” must be 4, 6 or 8 digits.`, `Alter “${l.desc}” → GST details → HSN/SAC.`); }
      if (l.qty && !UQC[norm(l.unit)] && !partyDone.has('u' + l.unit)) { partyDone.add('u' + l.unit); iss('warn', `Unit “${l.unit}” has no GST UQC — reported as OTH (Others).`, `Alter unit “${l.unit}” → Unit Quantity Code (UQC).`); }
      const h = hb[k] ||= { hsn_sc: l.hsn, desc: (l.desc || '').slice(0, 30), uqc: UQC[norm(l.unit)] || (l.qty ? 'OTH' : 'NA'), qty: 0, rt: r, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      const tv = Math.abs(l.amt), t = rates.length === 1 ? (txval ? taxTot * tv / txval : 0) : tv * r / 100;
      h.qty += sign * l.qty; h.txval += sign * tv; if (inter) h.iamt += sign * t; else { h.camt += sign * t / 2; h.samt += sign * t / 2; }
      h.csamt += sign * (txval ? tax.csamt * tv / txval : 0);
    }
    const itms = items.map((x, i) => ({ num: i + 1, itm_det: Object.fromEntries(Object.entries(x).filter(([k, vv]) => k === 'rt' || k === 'txval' || vv)) }));
    if (exportSale) { // Table 6A (exports) / 9B unregistered notes against exports
      const typ = tax.iamt > 0 ? 'WPAY' : 'WOPAY';
      const sb = { sbpcode: deepTxt(v, ['PORTCODE', 'SHIPPINGPORTCODE']), sbnum: deepTxt(v, ['SHIPPINGBILLNO', 'SHIPPINGBILLNUMBER', 'BILLOFENTRYNO']), sbdt: deepTxt(v, ['SHIPPINGBILLDATE', 'BILLOFENTRYDATE']) };
      if (sb.sbdt && /^\d{8}$/.test(sb.sbdt)) sb.sbdt = dmy(sb.sbdt);
      for (const k of Object.keys(sb)) if (!sb[k]) delete sb[k];
      const eit = items.map(x => ({ txval: x.txval, rt: x.rt, iamt: typ === 'WPAY' ? x.iamt : 0, csamt: x.csamt || 0 }));
      if (kind === 'S') (exp[typ] ||= []).push({ inum: no, idt: dmy(dt), val: r2(val), ...sb, itms: eit });
      else cdnur.push({ ntty: kind, nt_num: no, nt_dt: dmy(dt), val: r2(val), typ: typ === 'WPAY' ? 'EXPWP' : 'EXPWOP', itms: eit.map(x => ({ itm_det: x })) });
      continue;
    }
    const invTyp = sez ? (taxTot > 0 ? 'SEWP' : 'SEWOP') : 'R';
    const zeroRated = items.every(x => !x.rt);
    if (kind === 'S' && zeroRated && !sez) { // nil / exempt
      const t = (ctin ? 'B2B' : 'B2C'), k = `${inter ? 'INTR' : 'INTRA'}${t}`; nil[k] = (nil[k] || 0) + txval; continue;
    }
    if (ctin && party) names[ctin] = party;
    const inIff = ctin && b2bFrom && dt < b2bFrom; // already reported in IFF
    if (kind === 'S') {
      if (inIff) continue;
      if (ctin) (b2b[ctin] ||= []).push({ inum: no, idt: dmy(dt), val: r2(val), pos, rchrg: 'N', inv_typ: invTyp, itms });
      else if (inter && val > 100000) (b2cl[pos] ||= []).push({ inum: no, idt: dmy(dt), val: r2(val), itms });
      else for (const x of items) { const k = `${pos}|${x.rt}`; const b = b2cs[k] ||= { sply_ty: inter ? 'INTER' : 'INTRA', pos, typ: 'OE', rt: x.rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 }; for (const f of ['txval', 'iamt', 'camt', 'samt', 'csamt']) b[f] += x[f]; }
    } else {
      const nt = { ntty: kind, nt_num: no, nt_dt: dmy(dt), val: r2(val), pos, rchrg: 'N', inv_typ: invTyp, itms };
      if (inIff) continue;
      if (ctin) (cdnr[ctin] ||= []).push(nt);
      else if (inter && val > 100000) cdnur.push({ ntty: kind, nt_num: no, nt_dt: dmy(dt), val: r2(val), typ: 'B2CL', pos, itms });
      else for (const x of items) { const k = `${pos}|${x.rt}`, s = kind === 'C' ? -1 : 1; const b = b2cs[k] ||= { sply_ty: inter ? 'INTER' : 'INTRA', pos, typ: 'OE', rt: x.rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 }; for (const f of ['txval', 'iamt', 'camt', 'samt', 'csamt']) b[f] += s * x[f]; }
    }
  }
  const j = { gstin, fp };
  const b2bA = Object.entries(b2b).map(([ctin, inv]) => ({ ctin, inv })); if (b2bA.length) j.b2b = b2bA;
  const cdnrA = Object.entries(cdnr).map(([ctin, nt]) => ({ ctin, nt })); if (cdnrA.length) j.cdnr = cdnrA;
  if (!iff) {
    const expA = Object.entries(exp).map(([exp_typ, inv]) => ({ exp_typ, inv })); if (expA.length) j.exp = expA;
    const b2clA = Object.entries(b2cl).map(([pos, inv]) => ({ pos, inv })); if (b2clA.length) j.b2cl = b2clA;
    const b2csA = Object.values(b2cs).filter(b => Math.abs(b.txval) >= 0.01).map(b => Object.fromEntries(Object.entries(b).map(([k, x]) => [k, typeof x === 'number' ? r2(x) : x]))); if (b2csA.length) j.b2cs = b2csA;
    if (cdnur.length) j.cdnur = cdnur;
    const nilA = ['INTRB2B', 'INTRAB2B', 'INTRB2C', 'INTRAB2C'].filter(k => nil[k]).map(k => ({ sply_ty: k, nil_amt: r2(nil[k]), expt_amt: 0, ngsup_amt: 0 })); if (nilA.length) j.nil = { inv: nilA };
    const hl = o => Object.values(o).filter(h => Math.abs(h.txval) >= 0.01).map((h, i) => ({ num: i + 1, ...Object.fromEntries(Object.entries(h).map(([k, x]) => [k, typeof x === 'number' ? (k === 'qty' ? Math.round(x * 1000) / 1000 : r2(x)) : x])) }));
    const hb = hl(hsn.b2b), hc = hl(hsn.b2c); if (hb.length || hc.length) j.hsn = { ...(hb.length ? { hsn_b2b: hb } : {}), ...(hc.length ? { hsn_b2c: hc } : {}) };

    const docDet = [];
    for (const [n, label] of [[1, 'Invoices for outward supply'], [4, 'Debit Note'], [5, 'Credit Note']]) {
      const all = [...docs[n], ...cancelled[n]]; if (!all.length) continue;
      const sorted = all.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      docDet.push({ doc_num: n, doc_typ: label, docs: [{ num: 1, from: sorted[0], to: sorted[sorted.length - 1], totnum: all.length, cancel: cancelled[n].length, net_issue: all.length - cancelled[n].length }] });
    }
    if (docDet.length) j.doc_issue = { doc_det: docDet };
  }
  if (!used) warns.push('No GST sales, credit notes or debit notes were found in Tally for this period.');
  return { json: j, names, issues, vmap, count: used, warns: [...new Set(warns)].slice(0, 30) };
}
