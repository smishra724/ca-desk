// Clients → bookkeeping workspace.
// 1. Sync from Tally: ledgers (with group, GSTIN, state, GST duty) and the last 12 months of vouchers, so CA Desk
//    learns how each party is usually posted (voucher type, purchase/expense/sales ledger) and which bills are already in.
// 2. Upload purchase bills, sales invoices, expense slips (printed or handwritten), bank statements — PDF or photo.
//    Read with the free reader (printed PDFs) or with AI (photos, handwriting) and turned into draft vouchers.
// 3. Review every entry (document beside the voucher), approve, then post to Tally. Corrections are learnt.
import { extractText, toISO } from './extract.js';
import { tallyPost, tallyEnv, tallyParse, tallyEsc, tallyImport, tallyCompanies } from './tally.js';
import { isItrOnly } from './compliance.js';
import { initBankImport } from './bankimport.js';
import { initAiChat } from './aichat.js';
import { zohoReady, zohoExchange, zohoOrgs, zohoGet, zohoList } from './zoho.js';

const KINDS = [['purchase', 'Purchase bill'], ['sales', 'Sales invoice'], ['expense', 'Expense / receipt'], ['bank', 'Bank statement'], ['contra', 'Contra (cash / bank transfer)']];
const VTYPES = ['Purchase', 'Sales', 'Payment', 'Receipt', 'Contra', 'Journal', 'Credit Note', 'Debit Note'];
const STATUS = { review: 'To review', ready: 'Approved', posted: 'Posted', error: 'Error' };
const ls = { get: k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
const r2 = v => Math.round((+v || 0) * 100) / 100;
const inr = v => (+v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = s => String(s || '').toUpperCase().replace(/\b(M\/S|MESSRS|PVT|PRIVATE|LTD|LIMITED|LLP|AND|THE|CO|COMPANY)\b/g, ' ').replace(/[^A-Z0-9]+/g, ' ').trim();
const toks = s => norm(s).split(' ').filter(w => w.length > 2 && !/^\d+$/.test(w));
const ymd = iso => String(iso || '').replace(/-/g, '');
const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/g;

/* ---------- reading documents ---------- */
const AI_PROMPT = `You read Indian accounting documents for a CA firm. Return ONLY JSON, no prose.
If the document is an invoice, bill, receipt or voucher (printed or handwritten) return:
{"doc_type":"invoice","seller_name":"","seller_gstin":"","buyer_name":"","buyer_gstin":"","invoice_no":"","invoice_date":"YYYY-MM-DD","place_of_supply":"","lines":[{"description":"","hsn":"","qty":0,"rate":0,"amount":0,"gst_rate":0}],"taxable":0,"cgst":0,"sgst":0,"igst":0,"cess":0,"round_off":0,"total":0,"payment_mode":"cash|bank|credit|","notes":""}
If it is a bank statement return:
{"doc_type":"bank_statement","bank":"","account_no_last4":"","from":"YYYY-MM-DD","to":"YYYY-MM-DD","transactions":[{"date":"YYYY-MM-DD","narration":"","ref":"","debit":0,"credit":0,"balance":0}]}
Amounts are plain numbers in rupees. Use "" or 0 when a value is not on the document. Read handwriting carefully; never invent values.`;

async function b64(file) { const b = new Uint8Array(await file.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768)); return btoa(s); }
async function readWithAI(file) {
  const key = ls.get('cadesk.aiKey'); if (!key) throw new Error('Add your Anthropic API key first (Clients → AI reading).');
  const pdf = /pdf/.test(file.type) || /\.pdf$/i.test(file.name);
  const media = pdf ? 'application/pdf' : (file.type || 'image/jpeg');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: ls.get('cadesk.aiModel') || 'claude-sonnet-5-5', max_tokens: 8000,
      messages: [{ role: 'user', content: [{ type: pdf ? 'document' : 'image', source: { type: 'base64', media_type: media, data: await b64(file) } }, { type: 'text', text: AI_PROMPT }] }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`AI reading failed: ${j?.error?.message || r.status}`);
  const t = (j.content || []).map(c => c.text || '').join('');
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0) throw new Error('AI could not read this document.');
  return JSON.parse(t.slice(s, e + 1));
}
// free reader: invoice fields from plain text
function invoiceFromText(t, ownGstin) {
  const L = t.split('\n').map(x => x.trim()).filter(Boolean), U = t.toUpperCase();
  const gstins = [...new Set(U.match(GSTIN_RE) || [])];
  const amt = re => { const m = t.match(re); return m ? +m[1].replace(/,/g, '') : 0; };
  const sum = re => [...t.matchAll(re)].reduce((a, m) => a + (+m[1].replace(/,/g, '') || 0), 0);
  const no = (t.match(/(?:invoice|bill|inv)\s*(?:no|number|#)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]{0,20})/i) || [])[1] || '';
  const dt = (t.match(/(?:invoice|bill)?\s*date\s*[:\-]?\s*(\d{1,2}[\/\-.](?:\d{1,2}|[A-Za-z]{3})[\/\-.]\d{2,4})/i) || t.match(/\b(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})\b/) || [])[1] || '';
  const seller = gstins[0] || '', buyer = gstins[1] || '';
  const nameNear = g => { const i = L.findIndex(l => l.toUpperCase().includes(g)); for (let k = Math.max(0, i - 3); k < i; k++) if (/[A-Za-z]{3}/.test(L[k]) && !/invoice|gstin|tax|bill|original|duplicate/i.test(L[k])) return L[k]; return ''; };
  const cgst = sum(/CGST[^\n\d]{0,20}?(?:@\s*[\d.]+\s*%)?[^\n\d]{0,10}([\d,]+\.\d{2})/gi), sgst = sum(/(?:SGST|UTGST)[^\n\d]{0,20}?(?:@\s*[\d.]+\s*%)?[^\n\d]{0,10}([\d,]+\.\d{2})/gi), igst = sum(/IGST[^\n\d]{0,20}?(?:@\s*[\d.]+\s*%)?[^\n\d]{0,10}([\d,]+\.\d{2})/gi);
  const total = amt(/(?:grand\s*total|total\s*amount|invoice\s*total|net\s*amount|amount\s*payable|total)[^\n\d]{0,20}([\d,]+\.\d{2})(?![\s\S]*(?:grand\s*total|invoice\s*total))/i) || Math.max(0, ...(t.match(/[\d,]+\.\d{2}/g) || []).map(x => +x.replace(/,/g, '')));
  const round = amt(/round(?:ed)?\s*off[^\n\d-]{0,10}(-?[\d,]+\.\d{2})/i);
  const taxable = amt(/(?:taxable\s*(?:value|amount)|sub\s*total)[^\n\d]{0,20}([\d,]+\.\d{2})/i) || r2(total - cgst - sgst - igst - round);
  return { doc_type: 'invoice', seller_gstin: seller, buyer_gstin: buyer, seller_name: seller ? nameNear(seller) : (L[0] || ''), buyer_name: buyer ? nameNear(buyer) : '', invoice_no: no, invoice_date: toISO(dt), taxable, cgst, sgst, igst, cess: 0, round_off: round, total, lines: [], _free: true, _own: ownGstin };
}
// free reader: bank statement rows (date … amounts … balance)
function bankFromText(t) {
  const rows = [];
  let prevBal = null;
  for (const l of t.split('\n')) {
    const d = l.match(/^\s*(\d{1,2}[\/\-.](?:\d{1,2}|[A-Za-z]{3})[\/\-.]\d{2,4})/); if (!d) continue;
    const nums = [...l.matchAll(/(-?[\d,]+\.\d{2})(?:\s*(Cr|Dr))?/gi)].map(m => ({ v: +m[1].replace(/,/g, ''), s: (m[2] || '').toLowerCase() }));
    if (nums.length < 2) continue;
    const bal = nums[nums.length - 1].v * (nums[nums.length - 1].s === 'dr' ? -1 : 1), amt = nums[nums.length - 2].v;
    let debit = 0, credit = 0;
    if (prevBal !== null) { if (bal < prevBal) debit = amt; else credit = amt; } else if (/\b(cr|credit|by)\b/i.test(l)) credit = amt; else debit = amt;
    prevBal = bal;
    const narr = l.slice(d[0].length).replace(/(-?[\d,]+\.\d{2})(\s*(Cr|Dr))?/gi, ' ').replace(/\s+/g, ' ').trim();
    rows.push({ date: toISO(d[1]), narration: narr, ref: (narr.match(/\b(?:UTR|REF|CHQ|NEFT|IMPS|RTGS)[\s:\/-]*([A-Z0-9]{6,})/i) || [])[1] || '', debit, credit, balance: bal });
  }
  return { doc_type: 'bank_statement', transactions: rows, _free: true };
}

export function initBooks(ctx) {
  const { S, A, C, F, esc, toast, modal, closeModal, guard, render, isoToDisp, todayISO, db, fs, saveFile, busy, dispName, regsOf, isAdmin } = ctx;
  const { doc, getDoc, setDoc, getDocs, addDoc, updateDoc, deleteDoc, collection, serverTimestamp, writeBatch } = fs;
  const B = {};
  const st = () => (S.bk ||= { cid: '', tab: 'review', entries: [], meta: null, sel: new Set() });
  const client = () => S.clients.find(c => c.id === st().cid);
  const ownGstins = c => regsOf(c || {}).map(r => r.gstin).filter(Boolean);
  const opt = () => ({ port: ls.get('tallyPort') || '9000' });
  const meta = () => st().meta || {};
  const L = () => meta().ledgers || [];

  async function load(cid) {
    const s = st(); if (s.cid !== cid) s.bi = null; s.cid = cid; s.loading = true; s.sel = new Set(); render();
    const [m, e, z] = await Promise.all([getDoc(doc(db, 'clients', cid, 'booksmeta', 'main')), getDocs(collection(db, 'clients', cid, 'books')), getDoc(doc(db, 'clients', cid, 'booksmeta', 'zoho')).catch(() => null)]);
    if (s.cid !== cid) return;
    s.meta = m.exists() ? m.data() : {};
    s.zoho = z && z.exists() ? z.data() : null;
    s.entries = e.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.v?.date || '').localeCompare(a.v?.date || '') || (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    s.loading = false; render();
  }
  const saveMeta = async patch => { const s = st(); s.meta = { ...meta(), ...patch }; await setDoc(doc(db, 'clients', s.cid, 'booksmeta', 'main'), { ...patch, updatedAt: serverTimestamp() }, { merge: true }); };

  /* ---------- 1. sync masters + vouchers from Tally and learn ---------- */
  const kids = (el, tag) => [...(el?.children || [])].filter(c => c.tagName === tag);
  const tx = (el, tag) => (kids(el, tag)[0]?.textContent || '').trim();
  const amtOf = s => { s = String(s || ''); if (s.includes('=')) s = s.slice(s.lastIndexOf('=') + 1); const v = parseFloat(s.replace(/[^0-9.]/g, '')) || 0; return /-/.test(s) ? -v : v; };
  async function syncTally() {
    const s = st(), c = client(), company = meta().company;
    if (!company) throw new Error('Choose the Tally company for this client first.');
    const vars = `<SVCURRENTCOMPANY>${tallyEsc(company)}</SVCURRENTCOMPANY>`;
    busy(true, 'Reading groups and ledgers from Tally…');
    const gd = tallyParse(await tallyPost(tallyEnv('CDGrp', '<COLLECTION NAME="CDGrp" ISMODIFY="No"><TYPE>Group</TYPE><FETCH>Name,Parent</FETCH></COLLECTION>', vars), opt()), 'groups');
    const parent = {}; for (const g of gd.getElementsByTagName('GROUP')) parent[g.getAttribute('NAME')] = tx(g, 'PARENT');
    const root = g => { const chain = [g]; let x = g, n = 0; while (parent[x] && n++ < 20) { x = parent[x]; chain.push(x); } return chain.join(' > '); }; // e.g. Sundry Creditors > Current Liabilities
    let ld;
    for (const f of ['Name,Parent,PartyGSTIN,LedStateName,GSTDutyHead,TaxType,GSTDetails,LedGSTRegDetails,IsBillWiseOn', 'Name,Parent,PartyGSTIN,LedStateName,GSTDutyHead,TaxType']) {
      try { ld = tallyParse(await tallyPost(tallyEnv('CDLed', `<COLLECTION NAME="CDLed" ISMODIFY="No"><TYPE>Ledger</TYPE><FETCH>${f}</FETCH></COLLECTION>`, vars), opt()), 'ledgers'); break; } catch (e) { if (f.includes('IsBillWiseOn') && /^Tally:|could not be read/.test(e.message)) continue; throw e; }
    }
    const ledgers = [...ld.getElementsByTagName('LEDGER')].map(l => {
      const p = tx(l, 'PARENT'), g = (l.getElementsByTagName('GSTIN')[0]?.textContent || tx(l, 'PARTYGSTIN') || '').trim().toUpperCase();
      return { n: l.getAttribute('NAME'), p, r: root(p) || p, g, s: tx(l, 'LEDSTATENAME') || (l.getElementsByTagName('STATE')[0]?.textContent || '').trim(), d: tx(l, 'GSTDUTYHEAD'), t: tx(l, 'TAXTYPE') };
    }).filter(l => l.n);
    busy(true, 'Reading the last 12 months of vouchers to learn how entries are posted…');
    const to = new Date(), from = new Date(to.getFullYear() - 1, to.getMonth(), 1);
    const dvars = vars + `<SVFROMDATE>${ymd(isoD(from))}</SVFROMDATE><SVTODATE>${ymd(isoD(to))}</SVTODATE>`;
    const vd = tallyParse(await tallyPost(tallyEnv('CDVch', `<COLLECTION NAME="CDVch" ISMODIFY="No"><TYPE>Voucher</TYPE><FETCH>Date,VoucherTypeName,VoucherNumber,Reference,PartyLedgerName,Narration,IsCancelled,IsOptional,AllLedgerEntries</FETCH><FILTER>CDDt</FILTER></COLLECTION><SYSTEM TYPE="Formulae" NAME="CDDt">$Date &gt;= $$Date:"${from.getDate()}-${from.toLocaleString('en', { month: 'short' })}-${from.getFullYear()}"</SYSTEM>`, dvars), opt()), 'vouchers');
    const byName = Object.fromEntries(ledgers.map(l => [l.n, l]));
    const isParty = n => /sundry (debtors|creditors)/i.test(byName[n]?.r || '');
    const isDuty = n => /duties/i.test(byName[n]?.r || '') || /gst/i.test(byName[n]?.t || '');
    const isBankCash = n => /bank accounts|cash-in-hand|bank od|bank occ/i.test(byName[n]?.r || '') || /bank|cash/i.test(byName[n]?.p || '');
    const learn = {}, words = {}, dups = new Set();
    let nv = 0;
    for (const v of vd.getElementsByTagName('VOUCHER')) {
      if (tx(v, 'ISCANCELLED') === 'Yes' || tx(v, 'ISOPTIONAL') === 'Yes') continue;
      nv++;
      const vt = tx(v, 'VOUCHERTYPENAME') || v.getAttribute('VCHTYPE') || '', es = kids(v, 'ALLLEDGERENTRIES.LIST').concat(kids(v, 'LEDGERENTRIES.LIST')).map(e => ({ n: tx(e, 'LEDGERNAME'), a: amtOf(tx(e, 'AMOUNT')) })).filter(e => e.n);
      const party = tx(v, 'PARTYLEDGERNAME') || es.find(e => isParty(e.n))?.n || '';
      const ref = tx(v, 'REFERENCE') || tx(v, 'VOUCHERNUMBER');
      if (party && ref) dups.add(`${party}|${ref}`.toUpperCase());
      const counter = es.filter(e => e.n !== party && !isDuty(e.n) && !/round/i.test(e.n)).sort((a, b) => Math.abs(b.a) - Math.abs(a.a))[0]?.n;
      if (party && counter) { const k = learn[party] ||= {}; const key = `${vt}|${counter}`; k[key] = (k[key] || 0) + 1; }
      if (/payment|receipt|contra/i.test(vt)) {
        const bank = es.find(e => isBankCash(e.n))?.n, other = es.find(e => e.n !== bank && !isDuty(e.n))?.n;
        if (other) for (const w of new Set(toks(tx(v, 'NARRATION')))) { const k = words[w] ||= {}; const key = `${vt}|${other}`; k[key] = (k[key] || 0) + 1; }
      }
    }
    // keep the most common way each party / narration word is posted
    const best = o => Object.fromEntries(Object.entries(o).map(([p, m]) => { const [key, n] = Object.entries(m).sort((a, b) => b[1] - a[1])[0]; const [type, ledger] = key.split('|'); return [p, { type, ledger, n }]; }));
    const wordsBest = best(Object.fromEntries(Object.entries(words).filter(([, m]) => Object.values(m).reduce((a, b) => a + b, 0) >= 2)));
    await saveMeta({ ledgers, learn: { ...best(learn), ...(meta().learnManual || {}) }, words: wordsBest, dups: [...dups].slice(-6000), syncedAt: new Date().toISOString(), vouchers: nv });
    busy(false);
    return { ledgers: ledgers.length, vouchers: nv, parties: Object.keys(learn).length };
  }
  const isoD = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  /* ---------- 2. turn what was read into draft vouchers ---------- */
  const led = n => L().find(l => l.n === n);
  const under = re => L().filter(l => re.test(l.r) || re.test(l.p));
  function findParty(name, gstin) {
    if (gstin) { const x = L().find(l => l.g === gstin); if (x) return x.n; }
    const t = toks(name); if (!t.length) return '';
    let best = '', score = 0;
    for (const l of under(/sundry|debtors|creditors/i)) { const lt = toks(l.n); if (!lt.length) continue; const hit = t.filter(w => lt.includes(w)).length / Math.max(t.length, lt.length); if (hit > score) { score = hit; best = l.n; } }
    return score >= 0.6 ? best : '';
  }
  function gstLedgers(kind, rate, inter) {
    const out = {}, side = kind === 'sales' ? /output|payable|o\/p/i : /input|itc|receivable|i\/p/i;
    const duty = under(/duties/i).concat(L().filter(l => /gst/i.test(l.t))).filter((l, i, a) => a.indexOf(l) === i);
    const pick = (head, re) => { const c = duty.filter(l => re.test(l.d + ' ' + l.n)); const r = c.filter(l => side.test(l.n)); const pool = r.length ? r : c; const half = inter ? rate : rate / 2; return (pool.find(l => new RegExp(`\\b${half}\\s*%`).test(l.n)) || pool.find(l => !/\d+\s*%/.test(l.n)) || pool[0])?.n || ''; };
    if (inter) out.igst = pick('i', /integrated|igst/i); else { out.cgst = pick('c', /central|cgst/i); out.sgst = pick('s', /state|sgst|utgst/i); }
    out.cess = pick('x', /cess/i);
    return out;
  }
  const EXP_WORDS = [[/petrol|diesel|fuel|hpcl|iocl|bpcl|indian oil/i, /petrol|fuel|conveyance|vehicle/i], [/rent/i, /rent/i], [/airtel|jio|vodafone|vi |bsnl|mobile|telephone|internet|broadband/i, /telephone|mobile|internet|communication/i],
    [/stationery|printing|xerox|paper/i, /printing|stationery/i], [/hotel|restaurant|food|meal|tea|coffee|refreshment|swiggy|zomato/i, /staff welfare|refreshment|food|business promotion/i], [/uber|ola|taxi|cab|flight|train|irctc|travel/i, /travel|conveyance/i],
    [/repair|maintenance|service/i, /repair|maintenance/i], [/electricity|power|bses|uppcl|tata power/i, /electricity|power/i], [/courier|postage|dtdc|bluedart|speed post/i, /courier|postage/i], [/salary|wages/i, /salary|wages/i], [/bank charge|charges|commission|sms charges/i, /bank charges/i]];
  function guessExpense(text) { for (const [re, lre] of EXP_WORDS) if (re.test(text)) { const l = under(/expenses|indirect|direct/i).find(x => lre.test(x.n)); if (l) return l.n; } return ''; }

  function draftFromInvoice(x, kindHint, c) {
    const own = ownGstins(c), mineSeller = own.includes((x.seller_gstin || '').toUpperCase());
    let kind = kindHint && kindHint !== 'auto' ? kindHint : mineSeller ? 'sales' : (x.seller_gstin || x.buyer_gstin) ? 'purchase' : 'expense';
    const pName = kind === 'sales' ? x.buyer_name : x.seller_name, pGst = (kind === 'sales' ? x.buyer_gstin : x.seller_gstin || '').toUpperCase();
    const taxable = r2(x.taxable), cg = r2(x.cgst), sg = r2(x.sgst), ig = r2(x.igst), ce = r2(x.cess), ro = r2(x.round_off);
    const total = r2(x.total) || r2(taxable + cg + sg + ig + ce + ro);
    const inter = ig > 0 || (pGst && own[0] && pGst.slice(0, 2) !== own[0].slice(0, 2) && !(cg + sg));
    const rate = taxable ? Math.round(((cg + sg + ig) / taxable) * 100 * 4) / 4 : 0;
    let party = findParty(pName, pGst), newParty = null;
    const cashSlip = kind === 'expense' && (!pGst || /cash/i.test(x.payment_mode || ''));
    if (cashSlip) party = (under(/cash-in-hand/i)[0] || {}).n || 'Cash';
    else if (!party && pName) newParty = { name: pName.trim().replace(/\s+/g, ' ').toUpperCase(), group: kind === 'sales' ? 'Sundry Debtors' : 'Sundry Creditors', gstin: pGst, state: '' };
    const learnt = meta().learn?.[party];
    const ledger = learnt?.ledger && !/sundry/i.test(led(learnt.ledger)?.r || '') ? learnt.ledger
      : kind === 'sales' ? (under(/sales accounts/i).find(l => new RegExp(`\\b${rate}\\s*%`).test(l.n)) || under(/sales accounts/i)[0] || {}).n
      : kind === 'purchase' ? (under(/purchase accounts/i).find(l => new RegExp(`\\b${rate}\\s*%`).test(l.n)) || under(/purchase accounts/i)[0] || {}).n
      : guessExpense([x.seller_name, x.notes, ...(x.lines || []).map(l => l.description)].join(' '));
    const type = learnt?.type && VTYPES.includes(learnt.type) && !cashSlip ? learnt.type : kind === 'sales' ? 'Sales' : kind === 'purchase' ? 'Purchase' : cashSlip ? 'Payment' : 'Journal';
    const g = gstLedgers(kind, rate, inter);
    const warn = [];
    if (!party && !newParty) warn.push('Party not found');
    if (newParty) warn.push(`New party ledger will be created under ${newParty.group}`);
    if (!ledger) warn.push(`Choose the ${kind === 'sales' ? 'sales' : kind === 'purchase' ? 'purchase' : 'expense'} ledger`);
    if (Math.abs(total - (taxable + cg + sg + ig + ce + ro)) > 1) warn.push(`Amounts don't add up: taxable + GST = ${inr(taxable + cg + sg + ig + ce + ro)}, total ${inr(total)}`);
    if ((cg || sg || ig) && !((inter && g.igst) || (!inter && g.cgst && g.sgst))) warn.push('GST ledger not found in Tally — choose it');
    if (party && x.invoice_no && (meta().dups || []).includes(`${party}|${x.invoice_no}`.toUpperCase())) warn.push(`Already in Tally: ${party} bill ${x.invoice_no}`);
    if (!x.invoice_date) warn.push('Date not read');
    return { kind, v: { type, date: x.invoice_date || '', no: x.invoice_no || '', party, newParty, ledger: ledger || '', taxable, cgst: cg, sgst: sg, igst: ig, cess: ce, round: ro, total, gl: g, narration: [kind === 'sales' ? 'Sales to' : 'Bill from', pName, x.invoice_no ? `no. ${x.invoice_no}` : '', x.invoice_date ? `dated ${isoToDisp(x.invoice_date)}` : ''].filter(Boolean).join(' ') }, warn };
  }
  function draftFromBank(t, bankLedger) {
    const text = t.narration || '', words = toks(text);
    let ledger = '', type = t.credit ? 'Receipt' : 'Payment';
    // 1. a party / ledger name in the narration
    for (const l of L()) { if (l.n === bankLedger || /duties/i.test(l.r)) continue; const lt = toks(l.n); if (lt.length && lt.every(w => words.includes(w))) { ledger = l.n; break; } }
    // 2. what this narration word was posted to before
    if (!ledger) for (const w of words) { const k = meta().words?.[w]; if (k && k.ledger !== bankLedger) { ledger = k.ledger; if (/payment|receipt|contra/i.test(k.type)) type = k.type; break; } }
    // 3. cash deposits / withdrawals → contra
    if (!ledger && /\b(cash|atm|self|cdm)\b/i.test(text)) { ledger = (under(/cash-in-hand/i)[0] || {}).n || 'Cash'; }
    if (ledger && /bank accounts|cash-in-hand/i.test(led(ledger)?.r || '')) type = 'Contra';
    if (!ledger) ledger = guessExpense(text);
    const warn = []; if (!ledger) warn.push('Choose the ledger for this transaction (party, expense, income or another bank)');
    const amt = r2(t.credit || t.debit);
    return { kind: 'bank', v: { type, date: t.date, no: t.ref || '', party: ledger, ledger: bankLedger, total: amt, dir: t.credit ? 'in' : 'out', narration: text }, warn };
  }

  /* ---------- upload & read ---------- */
  async function addFiles(files, kindHint) {
    const s = st(), c = client(), mode = ls.get('cadesk.readMode') || 'both', bankLedger = s.bankLedger || '';
    if ((kindHint === 'bank' || kindHint === 'contra') && !bankLedger) throw new Error('Choose the bank ledger (in Tally) for this statement / slip first.');
    let n = 0, made = 0;
    for (const f of files) {
      n++;
      busy(true, `Saving ${f.name} (${n} of ${files.length})…`);
      const docId = await saveFile(s.cid, f, 'Bookkeeping', { kind: 'books' });
      let x = null, how = '';
      const useAI = mode === 'ai' || (mode === 'both' && (!/pdf/.test(f.type) || kindHint === 'expense'));
      try {
        if (useAI && ls.get('cadesk.aiKey')) { busy(true, `Reading ${f.name} with AI…`); x = await readWithAI(f); how = 'ai'; }
        else {
          busy(true, `Reading ${f.name}…`);
          const text = await extractText(f, m => busy(true, m));
          x = kindHint === 'bank' || /statement of account|account statement|opening balance|closing balance/i.test(text) ? bankFromText(text) : invoiceFromText(text, ownGstins(c)[0]);
          how = 'free';
          if (mode === 'both' && ls.get('cadesk.aiKey') && (x.doc_type === 'invoice' ? !(x.total && (x.invoice_no || x.seller_gstin)) : !x.transactions.length)) { busy(true, `Free reader got little from ${f.name} — reading with AI…`); x = await readWithAI(f); how = 'ai'; }
        }
      } catch (e) { x = { doc_type: 'invoice', _err: e.message }; how = 'failed'; }
      const src = { docId, name: f.name, how };
      if (x.doc_type === 'bank_statement') {
        if (!bankLedger) { toast('This looks like a bank statement — choose its bank ledger and upload it again as “Bank statement”.', 8000); continue; }
        let b = writeBatch(db), k = 0;
        for (const t of x.transactions || []) { const d = draftFromBank(t, bankLedger); b.set(doc(collection(db, 'clients', s.cid, 'books')), { src, ex: t, ...d, status: 'review', createdAt: serverTimestamp() }); made++; if (++k % 400 === 0) { await b.commit(); b = writeBatch(db); } }
        await b.commit();
      } else {
        if (kindHint === 'contra') { // deposit / withdrawal slip or transfer advice → Contra between cash and the chosen bank
          const amt = r2(x.total || x.taxable), cash = (L().find(l => /cash-in-hand/i.test(l.r)) || {}).n || 'Cash';
          const d = { kind: 'bank', v: { type: 'Contra', date: x.invoice_date || '', no: x.invoice_no || '', party: cash, ledger: bankLedger, total: amt, dir: /withdraw/i.test(JSON.stringify(x)) ? 'out' : 'in', narration: /withdraw/i.test(JSON.stringify(x)) ? 'Cash withdrawn from bank' : 'Cash deposited in bank' }, warn: bankLedger ? [] : ['Choose the bank ledger'] };
          await addDoc(collection(db, 'clients', s.cid, 'books'), { src, ex: x, ...d, status: 'review', createdAt: serverTimestamp() }); made++; continue;
        }
        const d = x._err ? { kind: kindHint || 'purchase', v: { type: 'Purchase', date: '', no: '', party: '', ledger: '', total: 0 }, warn: ['Could not read: ' + x._err] } : draftFromInvoice(x, kindHint, c);
        await addDoc(collection(db, 'clients', s.cid, 'books'), { src, ex: x, ...d, status: 'review', createdAt: serverTimestamp() }); made++;
      }
    }
    busy(false); await load(s.cid);
    return made;
  }

  /* ---------- 3. post to Tally ---------- */
  const E = (n, amt, extra = '') => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${tallyEsc(n)}</LEDGERNAME><ISDEEMEDPOSITIVE>${amt < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${r2(amt).toFixed(2)}</AMOUNT>${extra}</ALLLEDGERENTRIES.LIST>`;
  const bill = (no, amt) => no ? `<BILLALLOCATIONS.LIST><NAME>${tallyEsc(no)}</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>${r2(amt).toFixed(2)}</AMOUNT></BILLALLOCATIONS.LIST>` : '';
  function voucherXml(e) {
    const v = e.v, g = v.gl || {}, lines = [];
    // Tally: debit = negative amount (deemed positive), credit = positive amount
    if (e.kind === 'bank') {
      const amt = r2(v.total);
      if (v.dir === 'in') { lines.push(E(v.ledger, -amt), E(v.party, amt)); } else { lines.push(E(v.party, -amt), E(v.ledger, amt)); }
    } else {
      const taxes = [[g.cgst, v.cgst], [g.sgst, v.sgst], [g.igst, v.igst], [g.cess, v.cess]].filter(([n, a]) => n && +a);
      const sales = /sales|credit note/i.test(v.type) && e.kind === 'sales';
      const s = sales ? (/credit note/i.test(v.type) ? -1 : 1) : -1; // sales: Cr sales & output tax, Dr party (credit note: the other way); purchase/expense: Dr expense & input tax, Cr party
      const partyLed = v.party || v.newParty?.name;
      lines.push(E(partyLed, -s * v.total, /sundry/i.test((led(partyLed) || {}).r || v.newParty?.group || '') ? bill(v.no, -s * v.total) : ''));
      lines.push(E(v.ledger, s * v.taxable));
      for (const [n, a] of taxes) lines.push(E(n, s * a));
      if (+v.round) { const ro = (L().find(l => /round/i.test(l.n)) || {}).n; if (ro) lines.push(E(ro, s * v.round)); }
    }
    const isInv = false;
    return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${tallyEsc(v.type)}" ACTION="Create" OBJVIEW="Accounting Voucher View"><DATE>${ymd(v.date)}</DATE><EFFECTIVEDATE>${ymd(v.date)}</EFFECTIVEDATE><VOUCHERTYPENAME>${tallyEsc(v.type)}</VOUCHERTYPENAME>
      ${e.kind === 'sales' && v.no ? `<VOUCHERNUMBER>${tallyEsc(v.no)}</VOUCHERNUMBER>` : ''}${v.no ? `<REFERENCE>${tallyEsc(v.no)}</REFERENCE>` : ''}${e.kind !== 'bank' && v.date ? `<REFERENCEDATE>${ymd(v.date)}</REFERENCEDATE>` : ''}
      ${e.kind !== 'bank' ? `<PARTYLEDGERNAME>${tallyEsc(v.party || v.newParty?.name || '')}</PARTYLEDGERNAME>` : ''}<NARRATION>${tallyEsc((v.narration || '') + ' [CA Desk]')}</NARRATION><ISINVOICE>${isInv ? 'Yes' : 'No'}</ISINVOICE>${lines.join('')}</VOUCHER></TALLYMESSAGE>`;
  }
  const ledgerXml = p => `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${tallyEsc(p.name)}" ACTION="Create"><NAME.LIST><NAME>${tallyEsc(p.name)}</NAME></NAME.LIST><PARENT>${tallyEsc(p.group)}</PARENT><ISBILLWISEON>Yes</ISBILLWISEON>
    ${p.state ? `<LEDSTATENAME>${tallyEsc(p.state)}</LEDSTATENAME>` : ''}<COUNTRYNAME>India</COUNTRYNAME>${p.gstin ? `<PARTYGSTIN>${p.gstin}</PARTYGSTIN><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE><LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE><GSTIN>${p.gstin}</GSTIN></LEDGSTREGDETAILS.LIST>` : '<GSTREGISTRATIONTYPE>Unregistered/Consumer</GSTREGISTRATIONTYPE>'}</LEDGER></TALLYMESSAGE>`;
  function problems(e) {
    const v = e.v, p = [];
    if (!v.date) p.push('date'); if (!v.type) p.push('voucher type'); if (!(+v.total > 0)) p.push('amount');
    if (!(v.party || v.newParty?.name)) p.push(e.kind === 'bank' ? 'ledger' : 'party');
    if (!v.ledger) p.push(e.kind === 'bank' ? 'bank ledger' : 'purchase / sales / expense ledger');
    if (e.kind !== 'bank') {
      const g = v.gl || {};
      if (+v.cgst && !g.cgst) p.push('CGST ledger'); if (+v.sgst && !g.sgst) p.push('SGST ledger'); if (+v.igst && !g.igst) p.push('IGST ledger');
      if (Math.abs(+v.total - (+v.taxable + +v.cgst + +v.sgst + +v.igst + (+v.cess || 0) + (+v.round || 0))) > 0.05) p.push('amounts (taxable + GST + round off ≠ total)');
    }
    for (const n of [v.ledger, v.party, ...(Object.values(v.gl || {}))].filter(Boolean)) if (!led(n) && n !== v.newParty?.name) p.push(`ledger “${n}” is not in Tally (sync again or correct it)`);
    return p;
  }
  async function post(ids) {
    const s = st(), company = meta().company; if (!company) throw new Error('Choose the Tally company first.');
    let ok = 0, bad = 0;
    for (const id of ids) {
      const e = s.entries.find(x => x.id === id); if (!e || e.status === 'posted') continue;
      const p = problems(e);
      if (p.length) { await updateDoc(doc(db, 'clients', s.cid, 'books', id), { status: 'error', msg: 'Fix before posting: ' + p.join(', ') }); bad++; continue; }
      busy(true, `Posting ${ok + bad + 1} of ${ids.length} to Tally…`);
      try {
        if (e.v.newParty && !led(e.v.newParty.name)) {
          const r = await tallyImport(company, 'All Masters', ledgerXml(e.v.newParty), opt());
          if (r.errors && !/already exists/i.test(r.lineErrors.join(' '))) throw new Error('Could not create ledger: ' + (r.lineErrors[0] || 'error'));
          s.meta.ledgers = [...L(), { n: e.v.newParty.name, p: e.v.newParty.group, r: e.v.newParty.group, g: e.v.newParty.gstin || '', s: e.v.newParty.state || '' }];
        }
        const r = await tallyImport(company, 'Vouchers', voucherXml(e), opt());
        if (!r.created || r.errors) throw new Error(r.lineErrors[0] || 'Tally did not create the voucher');
        await updateDoc(doc(db, 'clients', s.cid, 'books', id), { status: 'posted', postedAt: new Date().toISOString(), postedBy: S.profile?.email || '', msg: '' });
        const party = e.v.party || e.v.newParty?.name; if (party && e.v.no) s.meta.dups = [...(s.meta.dups || []), `${party}|${e.v.no}`.toUpperCase()];
        ok++;
      } catch (err) { await updateDoc(doc(db, 'clients', s.cid, 'books', id), { status: 'error', msg: err.message }); bad++; }
    }
    await saveMeta({ ledgers: L(), dups: (meta().dups || []).slice(-6000) });
    busy(false); await load(s.cid);
    return { ok, bad };
  }
  // what you correct is remembered for the next bill of the same party / narration
  async function learnFrom(e) {
    const v = e.v, party = v.party || v.newParty?.name; if (!party) return;
    const patch = {};
    if (e.kind !== 'bank' && v.ledger) { const lm = { ...(meta().learnManual || {}), [party]: { type: v.type, ledger: v.ledger, n: 99 } }; patch.learnManual = lm; patch.learn = { ...(meta().learn || {}), [party]: lm[party] }; }
    if (e.kind === 'bank') { const w = { ...(meta().words || {}) }; for (const t of toks(v.narration).slice(0, 6)) w[t] = { type: v.type, ledger: v.party, n: 99 }; patch.words = w; }
    if (Object.keys(patch).length) await saveMeta(patch);
  }

  /* ---------- Zoho Books → entries to review ---------- */
  const zcfg = () => st().zoho;
  const saveZoho = async patch => { const s = st(); s.zoho = { ...(s.zoho || {}), ...patch }; await setDoc(doc(db, 'clients', s.cid, 'booksmeta', 'zoho'), { ...patch, updatedAt: serverTimestamp() }, { merge: true }); };
  function zTaxes(d) {
    const o = { cgst: 0, sgst: 0, igst: 0, cess: 0 };
    for (const x of d.taxes || []) { const n = String(x.tax_name || ''), a = +x.tax_amount || 0; if (/igst/i.test(n)) o.igst += a; else if (/cgst/i.test(n)) o.cgst += a; else if (/sgst|utgst/i.test(n)) o.sgst += a; else if (/cess/i.test(n)) o.cess += a; else if (/gst/i.test(n)) o.igst += a; }
    for (const k in o) o[k] = r2(o[k]);
    return o;
  }
  // a Zoho invoice / credit note in the same shape as a read bill, so the usual matching (party, sales ledger, GST ledgers) applies
  function zDraft(d, kind) {
    const c = client(), own = ownGstins(c), tx = zTaxes(d), round = r2(d.adjustment || 0), total = r2(d.total);
    const taxable = r2(total - tx.cgst - tx.sgst - tx.igst - tx.cess - round);
    const x = { doc_type: 'invoice', invoice_no: d.invoice_number || d.creditnote_number || '', invoice_date: d.date || '', buyer_name: d.customer_name || '', buyer_gstin: (d.gst_no || '').toUpperCase(), seller_gstin: own[0] || '', taxable, ...tx, round_off: round, total, lines: (d.line_items || []).map(l => ({ description: l.name || l.description || '', hsn: l.hsn_or_sac || '', amount: l.item_total })) };
    const dr = draftFromInvoice(x, 'sales', c);
    if (kind === 'credit') { dr.v.type = 'Credit Note'; dr.v.narration = `Credit note ${x.invoice_no} to ${x.buyer_name}${d.reference_number ? ` against ${d.reference_number}` : ''}`; }
    // the income account used in Zoho, when a Tally ledger has the same name
    const acc = [...new Set((d.line_items || []).map(l => l.account_name).filter(Boolean))];
    if (acc.length === 1) { const m = L().find(l => norm(l.n) === norm(acc[0])); if (m) dr.v.ledger = m.n; }
    if (/overseas/i.test(d.gst_treatment || '')) dr.warn.push('Export invoice (overseas customer) – check the export sales ledger');
    if (/sez/i.test(d.gst_treatment || '')) dr.warn.push('SEZ customer – check the ledger');
    if (d.currency_code && d.currency_code !== 'INR') dr.warn.push(`Invoice in ${d.currency_code} (rate ${d.exchange_rate || '?'}) – amounts are in ${d.currency_code}; convert before posting`);
    return { ...dr, ex: x };
  }
  function zPayment(p, gstOf) {
    const bank = (() => { const want = toks(p.account_name || ''); const bl = L().filter(l => /bank accounts|bank od|bank occ|cash-in-hand/i.test(l.r));
      let best = '', sc = 0; for (const l of bl) { const lt = toks(l.n); const h = want.filter(w => lt.includes(w)).length / Math.max(want.length || 1, lt.length || 1); if (h > sc) { sc = h; best = l.n; } }
      return sc >= 0.5 ? best : st().bankLedger || ''; })();
    let party = findParty(p.customer_name, gstOf[p.customer_id] || ''), newParty = null;
    if (!party && p.customer_name) newParty = { name: p.customer_name.trim().replace(/\s+/g, ' ').toUpperCase(), group: 'Sundry Debtors', gstin: gstOf[p.customer_id] || '', state: '' };
    const warn = []; if (!bank) warn.push(`Choose the bank ledger for Zoho account “${p.account_name || ''}”`); if (newParty) warn.push('New party ledger will be created under Sundry Debtors');
    return { kind: 'bank', v: { type: 'Receipt', date: p.date, no: p.payment_number || p.reference_number || '', party: party || newParty?.name || '', newParty, ledger: bank, total: r2(p.amount), dir: 'in', narration: `Received from ${p.customer_name}${p.reference_number ? ' – ref ' + p.reference_number : ''}${p.payment_mode ? ' (' + p.payment_mode + ')' : ''}` }, warn };
  }
  async function zohoFetch(from, to, want) {
    const s = st(), cfg = zcfg(); if (!cfg?.refreshToken) throw new Error('Connect Zoho Books first.');
    const seen = new Set(s.entries.map(e => e.src?.zohoId).filter(Boolean));
    let made = 0, skipped = 0; const gstOf = {};
    const add = async (id, name, d) => { await addDoc(collection(db, 'clients', s.cid, 'books'), { src: { how: 'zoho', zohoId: id, name }, ex: d.ex || {}, kind: d.kind, v: d.v, warn: d.warn || [], status: 'review', createdAt: serverTimestamp() }); made++; };
    for (const [what, kind, idk, label] of [['invoices', 'sales', 'invoice_id', 'invoice'], ['creditnotes', 'credit', 'creditnote_id', 'credit note']]) {
      if (!want[what]) continue;
      busy(true, `Zoho Books: listing ${what}…`);
      const list = (await zohoList(cfg, what, from, to, n => busy(true, `Zoho Books: ${n} ${what} found…`))).filter(x => !/^(draft|void)$/i.test(x.status || ''));
      let i = 0;
      for (const x of list) {
        i++; const zid = `${kind}:${x[idk]}`;
        if (x.customer_id && x.gst_no) gstOf[x.customer_id] = x.gst_no;
        if (seen.has(zid)) { skipped++; continue; }
        busy(true, `Zoho Books: reading ${label} ${i} of ${list.length}…`);
        const d = (await zohoGet(cfg, `${what}/${x[idk]}`))[what === 'invoices' ? 'invoice' : 'creditnote'];
        if (d.customer_id && d.gst_no) gstOf[d.customer_id] = d.gst_no;
        await add(zid, `Zoho ${label} ${d.invoice_number || d.creditnote_number || ''}`, zDraft(d, kind));
      }
    }
    if (want.customerpayments) {
      busy(true, 'Zoho Books: listing payments received…');
      const list = await zohoList(cfg, 'customerpayments', from, to);
      for (const p of list) { const zid = `rcpt:${p.payment_id}`; if (seen.has(zid)) { skipped++; continue; } await add(zid, `Zoho payment ${p.payment_number || ''}`, zPayment(p, gstOf)); }
    }
    await saveZoho({ lastFrom: from, lastTo: to, lastAt: new Date().toISOString() });
    busy(false); await load(s.cid);
    return { made, skipped };
  }
  function zohoRow() {
    const z = zcfg(), s = st();
    const t = new Date(), f = new Date(t.getFullYear(), t.getMonth() - 1, 1), iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const from = s.zFrom || (z?.lastTo ? iso(new Date(new Date(z.lastTo).getTime() + 864e5)) : iso(f)), to = s.zTo || iso(t);
    if (!z?.refreshToken) return `<div class="bk-zoho"><b>Zoho Books</b><span class="small muted">Bring this client's invoices, credit notes and payments from Zoho Books for review and posting to Tally.</span><button class="sm" data-act="bkZohoConnect">Connect Zoho Books</button></div>`;
    return `<div class="bk-zoho"><b>Zoho Books</b><span class="small">${esc(z.orgName || 'Organisation ' + z.orgId)}${z.lastAt ? ` · last fetched ${isoToDisp(z.lastFrom)} – ${isoToDisp(z.lastTo)}` : ''}</span>
      <label class="small">From <input type="date" id="bkZFrom" value="${from}"></label><label class="small">To <input type="date" id="bkZTo" value="${to}"></label>
      <label class="chk small"><input type="checkbox" id="bkZInv" checked> Invoices</label><label class="chk small"><input type="checkbox" id="bkZCn" checked> Credit notes</label><label class="chk small"><input type="checkbox" id="bkZPay" ${z.payments === false ? '' : 'checked'}> Payments received</label>
      <button class="sm primary" data-act="bkZohoFetch" ${m().syncedAt ? '' : 'title="Sync from Tally first so parties and ledgers match"'}>Fetch from Zoho</button><button class="sm ghost" data-act="bkZohoConnect" title="Zoho connection">⚙</button></div>`;
  }
  const m = () => meta();

  /* ---------- views ---------- */
  B.view = () => {
    const s = st(), grp = s.grp || 'active', cons = s.cons || '';
    const inGrp = c => grp === 'ex' ? c.exClient : grp === 'itr' ? !c.exClient && isItrOnly(c) : grp === 'all' ? true : !c.exClient && !isItrOnly(c);
    const base = S.clients.filter(inGrp);
    const consList = [...new Set(base.map(c => c.constitution || 'Not set'))].sort();
    const list = base.filter(c => !cons || (c.constitution || 'Not set') === cons).sort((a, b) => dispName(a).localeCompare(dispName(b)));
    const cnt = g => S.clients.filter(c => g === 'ex' ? c.exClient : g === 'itr' ? !c.exClient && isItrOnly(c) : g === 'all' ? true : !c.exClient && !isItrOnly(c)).length;
    const q = (s.q || '').toLowerCase();
    const shown = list.filter(c => !q || [dispName(c), c.name, c.pan, c.gstin, ...regsOf(c).map(r => r.gstin)].some(v => (v || '').toLowerCase().includes(q)));
    return `<div class="bk">
      <aside class="card bk-cl"><input placeholder="Search name, PAN, GSTIN…" value="${esc(s.q || '')}" data-change="bkQ" class="bk-q">
        <div class="bk-grp">${[['active', 'Active'], ['itr', 'ITR'], ['ex', 'Ex-clients'], ['all', 'All']].map(([k, l]) => `<button class="${grp === k ? 'on' : ''}" data-act="bkGrp" data-g="${k}">${l} <b>${cnt(k)}</b></button>`).join('')}</div>
        <select data-change="bkCons" class="bk-cons"><option value="">All types (${base.length})</option>${consList.map(x => `<option ${x === cons ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
        <div class="small muted bk-n">${shown.length} client${shown.length === 1 ? '' : 's'}</div>
        <div class="bk-list">${shown.map(c => `<button class="${c.id === s.cid ? 'on' : ''}" data-act="bkOpen" data-id="${c.id}"><b>${esc(dispName(c))}</b><span>${esc(c.constitution || '')}</span></button>`).join('')}</div></aside>
      <section class="bk-main">${s.cid ? (s.loading ? '<div class="card"><p class="muted">Loading…</p></div>' : work()) : `<div class="card bk-empty"><h2>Bookkeeping</h2><p>Pick a client on the left. Then sync its Tally company once, upload bills, receipts and bank statements (PDF or photo — printed or handwritten), review each entry and post them to Tally.</p>${aiCard()}</div>`}</section></div>`;
  };
  function aiCard() {
    const key = ls.get('cadesk.aiKey'), mode = ls.get('cadesk.readMode') || 'both';
    return `<div class="bk-ai"><b>Reading documents</b>
      <select data-change="bkMode"><option value="both" ${mode === 'both' ? 'selected' : ''}>Free reader for printed PDFs, AI for photos / handwriting</option><option value="free" ${mode === 'free' ? 'selected' : ''}>Free reader only</option><option value="ai" ${mode === 'ai' ? 'selected' : ''}>AI for everything</option></select>
      <span class="small ${key ? '' : 'muted'}">${key ? `AI reading on (key …${esc(key.slice(-4))})` : 'AI reading off'} — <a href="#" data-act="bkKey">${key ? 'change' : 'add Anthropic API key'}</a></span></div>`;
  }
  function work() {
    const s = st(), c = client(), m = meta(), es = s.entries;
    const cnt = k => es.filter(e => e.status === k).length;
    const tab = s.tab || 'review', rows = es.filter(e => e.status === tab);
    const banks = L().filter(l => /bank accounts|bank od|bank occ/i.test(l.r));
    const sel = s.sel || new Set();
    return `<div class="card">
        <div class="row-between wrap"><h2>${esc(dispName(c))}</h2>
          <div class="bk-tally"><span class="small">${m.company ? `Tally: <b>${esc(m.company)}</b>${m.syncedAt ? ` · synced ${isoToDisp(m.syncedAt.slice(0, 10))} · ${L().length} ledgers, ${m.vouchers || 0} vouchers learnt` : ' · not synced yet'}` : '<span class="red">Tally company not chosen</span>'}</span>
            <button class="sm" data-act="bkCompany">${m.company ? 'Change company' : 'Choose Tally company'}</button><button class="sm ${m.syncedAt ? '' : 'primary'}" data-act="bkSync" ${m.company ? '' : 'disabled'}>⟳ Sync from Tally</button></div></div>
        ${aiCard()}
        <div class="bk-up">
          <select id="bkKind">${[['auto', 'Detect automatically'], ...KINDS].map(([k, l]) => `<option value="${k}" ${s.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <select id="bkBank" data-change="bkBank" title="Bank ledger for statements"><option value="">Bank ledger for statements…</option>${banks.map(l => `<option ${l.n === s.bankLedger ? 'selected' : ''}>${esc(l.n)}</option>`).join('')}</select>
          <label class="tf-drop bk-drop">+ Upload bills, receipts, statements<input type="file" multiple accept=".pdf,image/*" data-change="bkFiles"></label>
        </div>
        ${zohoRow()}
        ${m.syncedAt ? '' : '<p class="small amber-t">Sync from Tally first — entries are matched to your ledgers and to how each party was posted before.</p>'}
      </div>
      <div class="bk-mode"><button class="${s.mode !== 'bank' ? 'on' : ''}" data-act="bkMode2" data-m="">Bills &amp; entries</button><button class="${s.mode === 'bank' ? 'on' : ''}" data-act="bkMode2" data-m="bank">🏦 Bank import</button><button class="${s.mode === 'ai' ? 'on' : ''}" data-act="bkMode2" data-m="ai">💬 Ask AI</button></div>
      ${s.mode === 'bank' ? BI.view() : s.mode === 'ai' ? AIC.view() : `<div class="card">
        <div class="row-between wrap"><div class="tabs-s">${['review', 'ready', 'error', 'posted'].map(k => `<button class="${tab === k ? 'on' : ''}" data-act="bkTab" data-t="${k}">${STATUS[k]} <b>${cnt(k)}</b></button>`).join('')}</div>
          <div class="btns">${tab === 'review' || tab === 'error' ? `<button class="sm" data-act="bkApprove" ${sel.size ? '' : 'disabled'}>Approve selected</button>` : ''}${tab === 'ready' ? `<button class="sm primary" data-act="bkPost" ${sel.size || cnt('ready') ? '' : 'disabled'}>Post ${sel.size ? sel.size + ' selected' : 'all approved'} to Tally</button>` : ''}${tab !== 'posted' ? `<button class="sm danger" data-act="bkDel" ${sel.size ? '' : 'disabled'}>Delete</button>` : ''}</div></div>
        <div class="reg-wrap"><table class="reg bk-t"><thead><tr><th><input type="checkbox" data-change="bkAll" ${rows.length && rows.every(e => sel.has(e.id)) ? 'checked' : ''}></th><th>Date</th><th>Type</th><th>Party / ledger</th><th>Posted to</th><th class="num">Amount</th><th>Document</th><th>Check</th></tr></thead><tbody>
        ${rows.map(e => { const v = e.v || {}, p = problems(e); return `<tr class="${sel.has(e.id) ? 'sel' : ''}"><td><input type="checkbox" data-change="bkSel" value="${e.id}" ${sel.has(e.id) ? 'checked' : ''}></td>
          <td class="nowrap">${isoToDisp(v.date) || '<span class="red">—</span>'}</td><td>${esc(v.type || '')}${e.kind === 'bank' ? `<div class="tiny muted">${v.dir === 'in' ? 'money in' : 'money out'}</div>` : ''}</td>
          <td><a href="#" data-act="bkEdit" data-id="${e.id}"><b>${esc(v.party || v.newParty?.name || '— choose —')}</b></a>${v.newParty ? ' <span class="tag amber">new ledger</span>' : ''}${v.no ? `<div class="tiny muted">${e.kind === 'bank' ? 'Ref' : 'Bill'} ${esc(v.no)}</div>` : ''}${e.kind === 'bank' ? `<div class="tiny muted">${esc((v.narration || '').slice(0, 60))}</div>` : ''}</td>
          <td class="small">${esc(v.ledger || '—')}</td><td class="num">${inr(v.total)}</td>
          <td class="small">${e.src?.how === 'zoho' ? `${esc((e.src.name || '').slice(0, 30))}<div class="tiny muted">from Zoho Books</div>` : `<a href="#" data-act="bkDoc" data-id="${e.id}">${esc((e.src?.name || '').slice(0, 26))}</a><div class="tiny muted">${e.src?.how === 'ai' ? 'read by AI' : e.src?.how === 'free' ? 'free reader' : e.src?.how === 'failed' ? 'not read' : ''}</div>`}</td>
          <td class="small">${e.status === 'posted' ? `<span class="tag green">In Tally</span>` : e.msg ? `<span class="red">${esc(e.msg)}</span>` : p.length ? `<span class="amber-t">Missing: ${esc(p.slice(0, 3).join(', '))}</span>` : (e.warn || []).length ? `<span class="amber-t">${esc(e.warn[0])}</span>` : '<span class="tag green">OK</span>'}</td></tr>`; }).join('')
          || `<tr><td colspan="8" class="empty muted">${tab === 'review' ? 'Nothing to review. Upload bills, receipts or a bank statement above.' : tab === 'ready' ? 'Approve entries in “To review” to post them.' : tab === 'posted' ? 'Nothing posted yet.' : 'No errors.'}</td></tr>`}
        </tbody></table></div></div>`}`;
  }

  /* ---------- review modal ---------- */
  async function fileOf(docId) {
    const d = await getDoc(doc(db, 'clients', st().cid, 'docs', docId)), m = d.data() || {};
    const ch = await getDocs(collection(db, 'clients', st().cid, 'docs', docId, 'chunks'));
    const b = ch.docs.sort((a, b) => a.id.localeCompare(b.id)).map(x => x.data().d).join('');
    return new File([Uint8Array.from(atob(b), c => c.charCodeAt(0))], m.name || 'document', { type: m.mime || 'application/octet-stream' });
  }
  const dl = (id, list) => `<datalist id="${id}">${list.map(l => `<option value="${esc(l.n)}">${esc(l.p)}</option>`).join('')}</datalist>`;
  async function openEdit(id) {
    const s = st(), e = s.entries.find(x => x.id === id), v = e.v || {}, g = v.gl || {};
    let url = '';
    try { const f = await fileOf(e.src.docId); url = URL.createObjectURL(f); s.docType = f.type; } catch { /* no preview */ }
    const pdf = /pdf/.test(s.docType || '');
    const field = (name, label, val, attrs = '') => `<label>${label}<input name="${name}" value="${esc(val ?? '')}" ${attrs}></label>`;
    modal(`<div class="bk-rev"><div class="bk-doc">${url ? (pdf ? `<iframe src="${url}#toolbar=0&view=FitH" style="width:100%;height:100%;min-height:70vh;border:0"></iframe>` : `<img src="${url}" alt="Document">`) : '<p class="muted">No preview.</p>'}</div>
      <form data-form="bkSave" class="bk-form"><input type="hidden" name="id" value="${id}">
        <h2>Review entry</h2>
        ${(e.warn || []).length ? `<div class="g1-msg warn"><ul>${e.warn.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}${e.msg ? `<div class="g1-msg err">${esc(e.msg)}</div>` : ''}
        <div class="grid">
          <label>Voucher type<select name="type">${VTYPES.map(t => `<option ${t === v.type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          ${field('date', 'Date', v.date, 'type="date" required')}
          ${field('no', e.kind === 'bank' ? 'Reference' : 'Bill / invoice no.', v.no)}
          ${e.kind === 'bank' ? `<label>Direction<select name="dir"><option value="in" ${v.dir === 'in' ? 'selected' : ''}>Money in (credit in bank)</option><option value="out" ${v.dir !== 'in' ? 'selected' : ''}>Money out (debit in bank)</option></select></label>` : ''}
          <label class="span2">${e.kind === 'bank' ? 'Ledger (party / expense / income / other bank)' : 'Party ledger'}<input name="party" list="bkAll" value="${esc(v.party || '')}" placeholder="${v.newParty ? 'New: ' + esc(v.newParty.name) : ''}"></label>
          ${e.kind !== 'bank' ? `<div class="span2 bk-newp ${v.newParty && !v.party ? '' : 'hide'}"><label class="chk"><input type="checkbox" name="mkParty" ${v.newParty && !v.party ? 'checked' : ''}> Create a new party ledger in Tally</label>
            <div class="grid">${field('npName', 'Name', v.newParty?.name || '')}<label>Under<select name="npGroup">${['Sundry Creditors', 'Sundry Debtors'].map(gp => `<option ${gp === v.newParty?.group ? 'selected' : ''}>${gp}</option>`).join('')}</select></label>${field('npGstin', 'GSTIN', v.newParty?.gstin || '', 'class="mono"')}${field('npState', 'State', v.newParty?.state || '')}</div></div>` : ''}
          <label class="span2">${e.kind === 'bank' ? 'Bank ledger' : e.kind === 'sales' ? 'Sales ledger' : e.kind === 'purchase' ? 'Purchase ledger' : 'Expense ledger'}<input name="ledger" list="bkAll" value="${esc(v.ledger || '')}"></label>
          ${e.kind !== 'bank' ? `${field('taxable', 'Taxable value', v.taxable, 'type="number" step="0.01"')}${field('total', 'Bill total', v.total, 'type="number" step="0.01" required')}
            ${field('cgst', 'CGST', v.cgst, 'type="number" step="0.01"')}<label>CGST ledger<input name="g_cgst" list="bkDuty" value="${esc(g.cgst || '')}"></label>
            ${field('sgst', 'SGST / UTGST', v.sgst, 'type="number" step="0.01"')}<label>SGST ledger<input name="g_sgst" list="bkDuty" value="${esc(g.sgst || '')}"></label>
            ${field('igst', 'IGST', v.igst, 'type="number" step="0.01"')}<label>IGST ledger<input name="g_igst" list="bkDuty" value="${esc(g.igst || '')}"></label>
            ${field('cess', 'Cess', v.cess, 'type="number" step="0.01"')}<label>Cess ledger<input name="g_cess" list="bkDuty" value="${esc(g.cess || '')}"></label>
            ${field('round', 'Round off', v.round, 'type="number" step="0.01"')}<div class="small muted bk-chk" id="bkSum"></div>` : field('total', 'Amount', v.total, 'type="number" step="0.01" required')}
          <label class="span2">Narration<textarea name="narration" rows="2">${esc(v.narration || '')}</textarea></label>
        </div>
        ${dl('bkAll', L().filter(l => !/duties/i.test(l.r)))}${dl('bkDuty', L().filter(l => /duties/i.test(l.r) || /gst/i.test(l.t)))}
        <div class="btns mt"><button class="primary" name="go" value="approve">Approve</button><button name="go" value="next">Approve &amp; next</button><button name="go" value="save">Save draft</button>
          ${e.src?.how !== 'ai' && e.src?.how !== 'zoho' && ls.get('cadesk.aiKey') ? `<button type="button" data-act="bkReAI" data-id="${id}">Read again with AI</button>` : ''}<button type="button" data-act="closeModal">Close</button></div>
        <p class="tiny muted">What you choose here is remembered for the next bill of this party${e.kind === 'bank' ? ' / similar narration' : ''}.</p>
      </form></div>`);
    document.querySelector('.modal-box')?.classList.add('wide');
    sumCheck();
  }
  function sumCheck() {
    const f = document.querySelector('[data-form=bkSave]'), out = document.getElementById('bkSum'); if (!f || !out) return;
    const n = k => +f.elements[k]?.value || 0, calc = n('taxable') + n('cgst') + n('sgst') + n('igst') + n('cess') + n('round');
    out.innerHTML = Math.abs(calc - n('total')) > 0.05 ? `<span class="red">Taxable + GST + round off = ${inr(calc)} ≠ total ${inr(n('total'))}</span>` : '<span class="green-t">✓ Amounts add up</span>';
  }
  document.addEventListener('input', e => { if (e.target.closest?.('[data-form=bkSave]')) sumCheck(); });

  /* ---------- actions ---------- */
  A.bkOpen = ({ id }) => guard(() => load(id));
  A.bkMode2 = ({ m }) => { st().mode = m; render(); };
  const BI = initBankImport({ S, A, C, F, esc, toast, modal, closeModal, guard, render, isoToDisp, db, fs, busy,
    k: { st, L, led, meta, saveMeta, opt, draftFromBank, bankFromText, toks } });
  B.onInput = el => BI.onInput(el);
  const AIC = initAiChat({ S, A, C, F, esc, toast, guard, render, isoToDisp, busy,
    k: { st, L, led, meta, opt, client, dispName, own: ownGstins, addLedger: l => { st().meta.ledgers = [...L(), l]; saveMeta({ ledgers: L() }); } } });
  C.bkQ = el => { st().q = el.value; render(); };
  A.bkGrp = ({ g }) => { const s = st(); s.grp = g; s.cons = ''; render(); };
  C.bkCons = el => { st().cons = el.value; render(); };
  C.bkMode = el => { ls.set('cadesk.readMode', el.value); render(); };
  C.bkBank = el => { st().bankLedger = el.value; };
  A.bkTab = ({ t }) => { const s = st(); s.tab = t; s.sel = new Set(); render(); };
  C.bkSel = el => { const s = st(); el.checked ? s.sel.add(el.value) : s.sel.delete(el.value); render(); };
  C.bkAll = el => { const s = st(); s.sel = el.checked ? new Set(s.entries.filter(e => e.status === (s.tab || 'review')).map(e => e.id)) : new Set(); render(); };
  A.bkKey = () => modal(`<h2>AI reading</h2><p class="small">Photos, scans and handwritten bills are read by Claude through your own Anthropic API key (about ₹1–3 per page, billed by Anthropic to you). Create a key at <b>console.anthropic.com → API keys</b> and paste it here. It is kept only in this browser on this computer.</p>
    <form data-form="bkKeySave" class="grid"><label class="span2">Anthropic API key<input name="key" type="password" value="${esc(ls.get('cadesk.aiKey'))}" placeholder="sk-ant-…" autocomplete="off"></label>
      <label class="span2">Model<input name="model" value="${esc(ls.get('cadesk.aiModel') || 'claude-sonnet-5-5')}"></label>
      <div class="span2 btns"><button class="primary">Save</button>${ls.get('cadesk.aiKey') ? '<button type="button" class="danger" data-act="bkKeyDel">Remove key</button>' : ''}<button type="button" data-act="closeModal">Cancel</button></div></form>`);
  F.bkKeySave = fd => { ls.set('cadesk.aiKey', String(fd.get('key')).trim()); ls.set('cadesk.aiModel', String(fd.get('model')).trim() || 'claude-sonnet-5-5'); closeModal(); render(); toast('Saved'); };
  A.bkKeyDel = () => { ls.set('cadesk.aiKey', ''); closeModal(); render(); };
  A.bkCompany = () => guard(async () => {
    busy(true, 'Connecting to Tally…');
    const list = await tallyCompanies(opt()); busy(false);
    const c = client(), own = ownGstins(c), w = toks(dispName(c));
    const guess = list.find(x => x.name === meta().company) || list.find(x => own.includes(x.gstin)) || list.find(x => w.length && w.every(t => toks(x.name).includes(t))) || list[0];
    modal(`<h2>Tally company for ${esc(dispName(c))}</h2><form data-form="bkCompanySave" class="grid">
      <label>Tally port<input name="port" value="${esc(opt().port)}" inputmode="numeric"></label>
      <label class="span2">Company (open in Tally)<select name="company">${list.map(x => `<option ${x.name === guess?.name ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <div class="span2 btns"><button class="primary">Save and sync</button><button type="button" data-act="closeModal">Cancel</button></div></form>`);
  });
  F.bkCompanySave = fd => guard(async () => {
    ls.set('tallyPort', String(fd.get('port')).replace(/\D/g, '') || '9000');
    await saveMeta({ company: fd.get('company') }); closeModal();
    const r = await syncTally(); render();
    toast(`Synced: ${r.ledgers} ledgers, ${r.vouchers} vouchers, ${r.parties} parties learnt`, 6000);
  });
  A.bkSync = () => guard(async () => { const r = await syncTally(); render(); toast(`Synced: ${r.ledgers} ledgers, ${r.vouchers} vouchers, ${r.parties} parties learnt`, 6000); });
  C.bkFiles = el => {
    const files = [...el.files]; el.value = ''; if (!files.length) return;
    const kind = document.getElementById('bkKind')?.value || 'auto'; st().kind = kind;
    guard(async () => { const n = await addFiles(files, kind); st().tab = 'review'; render(); toast(`${n} entr${n === 1 ? 'y' : 'ies'} ready to review`); });
  };
  A.bkEdit = ({ id }) => guard(() => openEdit(id));
  A.bkZohoConnect = () => {
    const z = zcfg() || {};
    modal(`<h2>Connect Zoho Books — ${esc(dispName(client()))}</h2>
      <ol class="small" style="margin:0 0 10px 18px;line-height:1.6">
        <li>Sign in to this client's Zoho account and open <b>api-console.zoho.${z.dc === 'com' ? 'com' : 'in'}</b> → <b>Add Client</b> → <b>Self Client</b> → Create. Copy the <b>Client ID</b> and <b>Client Secret</b> below.</li>
        <li>In the same Self Client open <b>Generate Code</b>, paste this scope, time 10 minutes, any description → Create, and copy the code:<br><code style="user-select:all">ZohoBooks.invoices.READ,ZohoBooks.creditnotes.READ,ZohoBooks.customerpayments.READ,ZohoBooks.settings.READ</code></li>
        <li>Paste the code below and click Connect (within 10 minutes). CA Desk only <b>reads</b> from Zoho; nothing is changed there.</li></ol>
      <form data-form="bkZohoSave" class="grid">
        <label>Zoho data centre<select name="dc"><option value="in" ${z.dc !== 'com' ? 'selected' : ''}>India (zoho.in)</option><option value="com" ${z.dc === 'com' ? 'selected' : ''}>Global (zoho.com)</option></select></label><label></label>
        <label class="span2">Client ID<input name="clientId" value="${esc(z.clientId || '')}" required autocomplete="off"></label>
        <label class="span2">Client Secret<input name="clientSecret" type="password" value="${esc(z.clientSecret || '')}" required autocomplete="off"></label>
        <label class="span2">Code${z.refreshToken ? ' <span class="muted small">(leave blank to keep the current connection)</span>' : ''}<input name="code" autocomplete="off" ${z.refreshToken ? '' : 'required'} placeholder="1000.xxxx…"></label>
        ${z.orgs?.length > 1 ? `<label class="span2">Organisation<select name="orgId">${z.orgs.map(o => `<option value="${esc(o.id)}" ${o.id === z.orgId ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>` : ''}
        <div class="span2 btns"><button class="primary">Connect</button>${z.refreshToken ? '<button type="button" class="danger" data-act="bkZohoOff">Disconnect</button>' : ''}<button type="button" data-act="closeModal">Cancel</button></div></form>`);
  };
  F.bkZohoSave = fd => guard(async () => {
    const z = zcfg() || {}, dc = fd.get('dc'), clientId = String(fd.get('clientId')).trim(), clientSecret = String(fd.get('clientSecret')).trim(), code = String(fd.get('code') || '').trim();
    if (!zohoReady()) throw new Error('Update the CA Desk Suite extension (Settings → Update now) and reload this page – Zoho Books works through it.');
    busy(true, 'Connecting to Zoho Books…');
    try {
      const refreshToken = code ? await zohoExchange({ dc, clientId, clientSecret, code }) : z.refreshToken;
      const cfg = { dc, clientId, clientSecret, refreshToken };
      const orgs = (await zohoOrgs(cfg)).map(o => ({ id: String(o.organization_id), name: o.name, gstin: o.tax_reg_no || '' }));
      if (!orgs.length) throw new Error('No Zoho Books organisation in this Zoho account.');
      const own = ownGstins(client());
      const org = orgs.find(o => o.id === fd.get('orgId')) || orgs.find(o => own.includes(String(o.gstin).toUpperCase())) || orgs[0];
      await saveZoho({ ...cfg, orgId: org.id, orgName: org.name, orgs, connectedAt: new Date().toISOString(), by: S.profile?.email || '' });
    } finally { busy(false); }
    closeModal(); render(); toast(`Zoho Books connected – ${zcfg().orgName}${zcfg().orgs.length > 1 ? ' (change the organisation with ⚙)' : ''}`, 6000);
  });
  A.bkZohoOff = () => { if (!confirm('Disconnect Zoho Books for this client? Entries already brought in stay.')) return; guard(async () => { await setDoc(doc(db, 'clients', st().cid, 'booksmeta', 'zoho'), { refreshToken: '', clientSecret: '', updatedAt: serverTimestamp() }, { merge: true }); st().zoho = null; closeModal(); render(); }, 'Disconnected'); };
  A.bkZohoFetch = () => guard(async () => {
    const s = st(), g = id => document.getElementById(id);
    const from = g('bkZFrom')?.value, to = g('bkZTo')?.value; s.zFrom = from; s.zTo = to;
    if (!from || !to || from > to) throw new Error('Choose the From and To dates.');
    if (!meta().syncedAt) throw new Error('Sync from Tally first, so Zoho customers and accounts are matched to your Tally ledgers.');
    const want = { invoices: g('bkZInv')?.checked, creditnotes: g('bkZCn')?.checked, customerpayments: g('bkZPay')?.checked };
    const r = await zohoFetch(from, to, want).finally(() => busy(false));
    s.tab = 'review'; s.zFrom = s.zTo = ''; render();
    toast(`${r.made} entr${r.made === 1 ? 'y' : 'ies'} from Zoho Books ready to review${r.skipped ? ` · ${r.skipped} already brought in before` : ''}`, 7000);
  });
  A.bkDoc = ({ id }) => guard(async () => { const e = st().entries.find(x => x.id === id), f = await fileOf(e.src.docId); window.open(URL.createObjectURL(f), '_blank'); });
  A.bkReAI = ({ id }) => guard(async () => {
    const s = st(), e = s.entries.find(x => x.id === id); busy(true, 'Reading with AI…');
    const x = await readWithAI(await fileOf(e.src.docId));
    if (x.doc_type === 'bank_statement') throw new Error('AI says this is a bank statement — delete this entry and upload it as “Bank statement”.');
    const d = draftFromInvoice(x, e.kind === 'bank' ? 'auto' : e.kind, client());
    await updateDoc(doc(db, 'clients', s.cid, 'books', id), { ex: x, ...d, src: { ...e.src, how: 'ai' }, msg: '' });
    busy(false); closeModal(); await load(s.cid); openEdit(id);
  });
  F.bkSave = (fd, form, ev) => guard(async () => {
    const s = st(), id = fd.get('id'), e = s.entries.find(x => x.id === id), go = ev?.submitter?.value || 'approve';
    const n = k => r2(fd.get(k)), v = { ...e.v, type: fd.get('type'), date: fd.get('date'), no: String(fd.get('no') || '').trim(), party: String(fd.get('party') || '').trim(), ledger: String(fd.get('ledger') || '').trim(), total: n('total'), narration: fd.get('narration') };
    if (e.kind === 'bank') v.dir = fd.get('dir');
    else {
      Object.assign(v, { taxable: n('taxable'), cgst: n('cgst'), sgst: n('sgst'), igst: n('igst'), cess: n('cess'), round: n('round'), gl: { cgst: fd.get('g_cgst') || '', sgst: fd.get('g_sgst') || '', igst: fd.get('g_igst') || '', cess: fd.get('g_cess') || '' } });
      v.newParty = fd.get('mkParty') && !led(v.party) ? { name: String(fd.get('npName') || v.party).trim().toUpperCase(), group: fd.get('npGroup'), gstin: String(fd.get('npGstin') || '').trim().toUpperCase(), state: String(fd.get('npState') || '').trim() } : null;
      if (v.newParty) v.party = '';
    }
    const ne = { ...e, v }, p = problems(ne);
    const status = go === 'save' ? 'review' : p.length ? 'review' : 'ready';
    await updateDoc(doc(db, 'clients', s.cid, 'books', id), { v, status, msg: go !== 'save' && p.length ? 'Fix before approving: ' + p.join(', ') : '', reviewedBy: S.profile?.email || '' });
    if (go !== 'save' && !p.length) await learnFrom(ne);
    closeModal(); await load(s.cid);
    if (go !== 'save' && p.length) { toast('Not approved — ' + p.join(', '), 7000); return openEdit(id); }
    if (go === 'next') { const nx = s.entries.find(x => x.status === 'review' && x.id !== id); if (nx) openEdit(nx.id); }
  }, 'Saved');
  A.bkApprove = () => guard(async () => {
    const s = st(); let ok = 0, left = 0;
    for (const id of s.sel) { const e = s.entries.find(x => x.id === id), p = problems(e); if (p.length) { left++; await updateDoc(doc(db, 'clients', s.cid, 'books', id), { msg: 'Fix before approving: ' + p.join(', ') }); continue; } await updateDoc(doc(db, 'clients', s.cid, 'books', id), { status: 'ready', msg: '' }); await learnFrom(e); ok++; }
    s.sel = new Set(); await load(s.cid); toast(`${ok} approved${left ? `, ${left} need fixing (open them to correct)` : ''}`, 6000);
  });
  A.bkPost = () => {
    const s = st(), ids = s.sel.size ? [...s.sel] : s.entries.filter(e => e.status === 'ready').map(e => e.id);
    if (!confirm(`Post ${ids.length} approved entr${ids.length === 1 ? 'y' : 'ies'} to Tally company “${meta().company}”?\n\nNew party ledgers marked in the entries are created first. Each voucher is tagged [CA Desk] in its narration.`)) return;
    guard(async () => { const r = await post(ids); s.sel = new Set(); s.tab = r.bad ? 'error' : 'posted'; render(); toast(`${r.ok} posted to Tally${r.bad ? `, ${r.bad} with errors — see the Error tab` : ''}`, 7000); });
  };
  A.bkDel = () => { const s = st(); if (!confirm(`Delete ${s.sel.size} entr${s.sel.size === 1 ? 'y' : 'ies'}? (The uploaded documents stay in the client’s Documents.)`)) return; guard(async () => { for (const id of s.sel) await deleteDoc(doc(db, 'clients', s.cid, 'books', id)); s.sel = new Set(); await load(s.cid); }, 'Deleted'); };
  return B;
}
