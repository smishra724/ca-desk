// Books status: up to which date each client's books are written in Tally – every bank account, sales, purchase
// and journal. Marked by hand (calendar) or read from Tally (last voucher date of each kind / each bank ledger).
// Kept on the client document as booksTill = { bank: { "<ledger>": "yyyy-mm-dd" }, sales, purchase, journal, syncedAt, src, company }.
import { tallyPost, tallyEnv, tallyParse, tallyEsc, tallyCompanies } from './tally.js';

const KINDS = [['sales', 'Sales'], ['purchase', 'Purchase'], ['journal', 'Journal']];
const ls = { get: k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } } };
const toks = s => String(s || '').toUpperCase().replace(/\b(M\/S|PVT|PRIVATE|LTD|LIMITED|LLP|AND|THE|CO|COMPANY)\b/g, ' ').replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(w => w.length > 2);
const sim = (a, b) => { const x = toks(a), y = new Set(toks(b)); if (!x.length || !y.size) return 0; return x.filter(t => y.has(t)).length / Math.max(x.length, y.size); };
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const tDate = s => /^\d{8}$/.test(s || '') ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : '';
const addDay = d => { const x = new Date(d + 'T00:00'); x.setDate(x.getDate() + 1); return iso(x); };

export function initBooksStatus(ctx) {
  const { S, A, C, F, esc, toast, modal, closeModal, guard, render, isoToDisp, db, fs, busy, dispName, isAdmin, isItrOnly, openDataRequest, lastReminder } = ctx;
  const { doc, getDoc, setDoc, updateDoc } = fs;
  const BS = {};
  const st = () => (S.bs ||= { q: '', lag: '', only: '' });
  const opt = () => ({ port: ls.get('tallyPort') || '9000' });
  const today = () => iso(new Date());
  const daysSince = d => d ? Math.floor((new Date(today() + 'T00:00') - new Date(d + 'T00:00')) / 864e5) : Infinity;
  const lagCls = d => !d ? 'none' : daysSince(d) <= 15 ? 'ok' : daysSince(d) <= 45 ? 'amber' : 'red';
  const bt = c => c.booksTill || {};
  const oldest = c => { const b = bt(c); const all = [...Object.values(b.bank || {}), b.sales, b.purchase, b.journal].filter(Boolean); return all.length ? all.sort()[0] : ''; };

  /* ---------- what the client still has to send (used in WhatsApp / email messages) ---------- */
  BS.dataLines = c => {
    const b = bt(c), out = [], t = today();
    for (const [n, d] of Object.entries(b.bank || {})) if (d && d < t) out.push(`Bank statement – ${n}: from ${isoToDisp(addDay(d))} till date`);
    if (b.sales && b.sales < t) out.push(`Sales invoices from ${isoToDisp(addDay(b.sales))} till date`);
    if (b.purchase && b.purchase < t) out.push(`Purchase bills from ${isoToDisp(addDay(b.purchase))} till date`);
    if (b.journal && b.journal < t && daysSince(b.journal) > 31) out.push(`Expense vouchers / other entries from ${isoToDisp(addDay(b.journal))} till date`);
    return out;
  };

  /* ---------- save ---------- */
  async function save(c, booksTill) {
    booksTill = { ...booksTill, at: new Date().toISOString(), by: S.profile?.email || '' };
    await updateDoc(doc(db, 'clients', c.id), { booksTill });
    c.booksTill = booksTill;
  }

  /* ---------- read from Tally ---------- */
  async function companyFor(c, list) {
    let m = {}; try { const s = await getDoc(doc(db, 'clients', c.id, 'booksmeta', 'main')); m = s.exists() ? s.data() : {}; } catch { /* none yet */ }
    if (m.company) return m.company;
    if (bt(c).company) return bt(c).company;
    list = list || (await tallyCompanies(opt())).map(x => x.name || x);
    const names = [c.name, c.tradeName, ...(c.gstRegs || []).map(r => r.tradeName)].filter(Boolean);
    const best = list.map(n => ({ n, s: Math.max(...names.map(x => sim(x, n)), 0) })).sort((a, b) => b.s - a.s)[0];
    if (best && best.s >= 0.6) { await setDoc(doc(db, 'clients', c.id, 'booksmeta', 'main'), { company: best.n }, { merge: true }); return best.n; }
    return '';
  }
  async function readTally(company) {
    const vars = `<SVCURRENTCOMPANY>${tallyEsc(company)}</SVCURRENTCOMPANY>`;
    const kids = (el, tag) => [...(el?.children || [])].filter(x => x.tagName === tag);
    const tx = (el, tag) => (kids(el, tag)[0]?.textContent || '').trim();
    const gd = tallyParse(await tallyPost(tallyEnv('CDBsGrp', '<COLLECTION NAME="CDBsGrp" ISMODIFY="No"><TYPE>Group</TYPE><FETCH>Name,Parent</FETCH></COLLECTION>', vars), opt()), 'groups');
    const gp = {}; for (const g of gd.getElementsByTagName('GROUP')) gp[g.getAttribute('NAME')] = tx(g, 'PARENT');
    const chain = g => { const out = [g]; let x = g, n = 0; while (gp[x] && n++ < 20) { x = gp[x]; out.push(x); } return out.join('>'); };
    const ld = tallyParse(await tallyPost(tallyEnv('CDBsLed', '<COLLECTION NAME="CDBsLed" ISMODIFY="No"><TYPE>Ledger</TYPE><FETCH>Name,Parent</FETCH></COLLECTION>', vars), opt()), 'ledgers');
    const banks = new Set();
    for (const l of ld.getElementsByTagName('LEDGER')) { const n = l.getAttribute('NAME'), p = tx(l, 'PARENT'); if (n && /bank accounts|bank od a\/c|bank occ a\/c/i.test(chain(p) + '>' + p)) banks.add(n); }
    const vt = {};
    try { const vd = tallyParse(await tallyPost(tallyEnv('CDBsVt', '<COLLECTION NAME="CDBsVt" ISMODIFY="No"><TYPE>VoucherType</TYPE><FETCH>Name,Parent</FETCH></COLLECTION>', vars), opt()), 'voucher types');
      for (const v of vd.getElementsByTagName('VOUCHERTYPE')) vt[v.getAttribute('NAME')] = tx(v, 'PARENT'); } catch { /* names are used */ }
    const base = n => { let x = n, k = 0; while (vt[x] && vt[x] !== x && k++ < 10) x = vt[x]; return x; };
    const from = new Date(); from.setMonth(from.getMonth() - 18); from.setDate(1);
    const dv = vars + `<SVFROMDATE>${iso(from).replace(/-/g, '')}</SVFROMDATE><SVTODATE>${today().replace(/-/g, '')}</SVTODATE>`;
    const vd = tallyParse(await tallyPost(tallyEnv('CDBsVch', `<COLLECTION NAME="CDBsVch" ISMODIFY="No"><TYPE>Voucher</TYPE><FETCH>Date,VoucherTypeName,IsCancelled,IsOptional,AllLedgerEntries.LedgerName,LedgerEntries.LedgerName</FETCH><FILTER>CDBsDt</FILTER></COLLECTION><SYSTEM TYPE="Formulae" NAME="CDBsDt">$Date &gt;= $$Date:"${from.getDate()}-${from.toLocaleString('en', { month: 'short' })}-${from.getFullYear()}"</SYSTEM>`, dv), opt()), 'vouchers');
    const out = { bank: {}, sales: '', purchase: '', journal: '' };
    const max = (a, b) => (!a || b > a ? b : a);
    let n = 0;
    for (const v of vd.getElementsByTagName('VOUCHER')) {
      if (tx(v, 'ISCANCELLED') === 'Yes' || tx(v, 'ISOPTIONAL') === 'Yes') continue;
      const d = tDate(tx(v, 'DATE')); if (!d) continue; n++;
      const b = base(tx(v, 'VOUCHERTYPENAME') || v.getAttribute('VCHTYPE') || '').toLowerCase();
      if (b === 'sales') out.sales = max(out.sales, d);
      else if (b === 'purchase') out.purchase = max(out.purchase, d);
      else if (b === 'journal') out.journal = max(out.journal, d);
      for (const e of [...kids(v, 'ALLLEDGERENTRIES.LIST'), ...kids(v, 'LEDGERENTRIES.LIST')]) { const ln = tx(e, 'LEDGERNAME'); if (banks.has(ln)) out.bank[ln] = max(out.bank[ln], d); }
    }
    for (const b of banks) if (!(b in out.bank)) out.bank[b] = '';
    return { ...out, vouchers: n };
  }
  async function syncOne(c, list) {
    const company = await companyFor(c, list);
    if (!company) throw new Error(`${dispName(c)}: no matching company open in Tally. Open it in Tally, or set it in Clients → ${dispName(c)} → Choose Tally company.`);
    busy(true, `Reading ${company} from Tally…`);
    const r = await readTally(company);
    const old = bt(c), bank = {};
    for (const [k, v] of Object.entries(r.bank)) bank[k] = v || old.bank?.[k] || '';
    await save(c, { bank, sales: r.sales || old.sales || '', purchase: r.purchase || old.purchase || '', journal: r.journal || old.journal || '', syncedAt: new Date().toISOString(), src: 'tally', company });
    return r.vouchers;
  }

  /* ---------- page ---------- */
  const cell = d => `<span class="bs-d ${lagCls(d)}">${d ? isoToDisp(d) : '—'}</span>${d ? `<small class="muted"> ${daysSince(d)}d</small>` : ''}`;
  BS.view = () => {
    const s = st(), q = s.q.toLowerCase();
    let list = S.clients.filter(c => !isItrOnly(c) && !c.exClient);
    if (q) list = list.filter(c => [c.name, c.tradeName, c.gstin, c.pan].some(v => (v || '').toLowerCase().includes(q)));
    if (s.only === 'set') list = list.filter(c => oldest(c));
    if (s.lag) list = list.filter(c => { const o = oldest(c); return o && daysSince(o) > +s.lag; });
    if (s.only === 'norem') list = list.filter(c => { const r = lastReminder(c); return !r || daysSince(r.at.slice(0, 10)) >= 3; });
    list.sort((a, b) => (oldest(a) || '9').localeCompare(oldest(b) || '9') || dispName(a).localeCompare(dispName(b)));
    return `<section class="card">
      <div class="row-between wrap"><h2>Books updated till <span class="muted">(${list.length} client${list.length === 1 ? '' : 's'})</span></h2>
        <div class="btns"><button class="sm primary" data-act="bsSyncAll" title="Reads every company open in Tally now">⟳ Sync all open in Tally</button></div></div>
      <div class="filters"><input id="bsQ" placeholder="Search client, GSTIN, PAN…" value="${esc(s.q)}">
        <select data-change="bsF" data-k="lag"><option value="">Any date</option>${[15, 30, 45, 60, 90].map(n => `<option value="${n}" ${String(n) === s.lag ? 'selected' : ''}>Behind by more than ${n} days</option>`).join('')}</select>
        <select data-change="bsF" data-k="only"><option value="">All business clients</option><option value="set" ${s.only === 'set' ? 'selected' : ''}>Only clients with dates</option><option value="norem" ${s.only === 'norem' ? 'selected' : ''}>Not reminded in the last 3 days</option></select></div>
      <p class="muted small">Oldest first. Click a date to mark it by hand, or <b>⟳ Tally</b> to read the last entry of each kind (each bank ledger, sales, purchase, journal) from TallyPrime. <span class="bs-d ok">≤ 15 days</span> <span class="bs-d amber">≤ 45 days</span> <span class="bs-d red">older</span></p>
      <div class="tblwrap"><table class="tbl bs"><thead><tr><th>Client</th><th>Bank statements</th>${KINDS.map(([, l]) => `<th>${l}</th>`).join('')}<th>Updated</th><th>Last reminder</th><th></th></tr></thead><tbody>
      ${list.map(c => { const b = bt(c), banks = Object.entries(b.bank || {}), r = lastReminder(c); return `<tr>
        <td><a href="#" data-act="open" data-id="${c.id}">${esc(dispName(c))}</a>${b.company ? `<div class="muted tiny">Tally: ${esc(b.company)}</div>` : ''}</td>
        <td class="bs-banks">${banks.length ? banks.map(([n, d]) => `<button class="bs-c" data-act="bsMark" data-id="${c.id}" title="Mark ${esc(n)}"><span class="bs-n">${esc(n)}</span> ${cell(d)}</button>`).join('') : `<button class="bs-c" data-act="bsMark" data-id="${c.id}"><span class="muted">+ add bank</span></button>`}</td>
        ${KINDS.map(([k]) => `<td><button class="bs-c" data-act="bsMark" data-id="${c.id}">${cell(b[k])}</button></td>`).join('')}
        <td class="small muted nowrap">${b.at ? `${isoToDisp(b.at.slice(0, 10))}<div class="tiny">${b.src === 'tally' ? 'from Tally' : 'by hand'}</div>` : '—'}</td>
        <td class="small nowrap">${r ? `${isoToDisp(r.at.slice(0, 10))}<div class="tiny muted">${daysSince(r.at.slice(0, 10))}d ago · ${r.via === 'wa' ? 'WhatsApp' : 'email'}</div>` : '<span class="muted">never</span>'}</td>
        <td class="nowrap">${isAdmin() ? `<button class="sm" data-act="bsSync" data-id="${c.id}" title="Read from Tally">⟳ Tally</button> <button class="sm wa" data-act="bsAsk" data-id="${c.id}" title="Ask the client for the data still missing">Request data</button>` : ''}</td></tr>`; }).join('') || '<tr><td colspan="8" class="muted">No clients match.</td></tr>'}
      </tbody></table></div></section>`;
  };

  // one line on the client page
  BS.clientLine = c => {
    if (!c?.id || isItrOnly(c)) return '';
    const b = bt(c), banks = Object.entries(b.bank || {});
    const bit = (l, d) => `<span class="bs-i">${esc(l)} <span class="bs-d ${lagCls(d)}">${d ? isoToDisp(d) : '—'}</span></span>`;
    return `<div class="quick bs-line"><span class="muted small">Books updated till:</span>${banks.map(([n, d]) => bit(n, d)).join('')}${KINDS.map(([k, l]) => bit(l, b[k])).join('')}
      ${isAdmin() ? `<button class="sm" data-act="bsMark" data-id="${c.id}">Mark</button><button class="sm" data-act="bsSync" data-id="${c.id}">⟳ Tally</button><button class="sm wa" data-act="bsAsk" data-id="${c.id}">Request data</button>` : ''}</div>`;
  };

  /* ---------- mark by hand ---------- */
  BS.markForm = cid => {
    const c = S.clients.find(x => x.id === cid), b = bt(c), banks = Object.entries(b.bank || {});
    modal(`<h2>Books updated till — ${esc(dispName(c))}</h2><form data-form="bsSave" data-id="${cid}" class="grid">
      <p class="span2 muted small">The last date entered in Tally for each. Leave blank if not kept.</p>
      <div class="span2"><b class="small">Bank statements</b><div id="bsBanks">${(banks.length ? banks : [['', '']]).map(([n, d], i) => bankRow(n, d, i)).join('')}</div>
        <button type="button" class="sm" data-act="bsAddBank">+ Add another bank</button></div>
      ${KINDS.map(([k, l]) => `<label>${l} till<input type="date" name="${k}" value="${esc(b[k] || '')}" max="${today()}"></label>`).join('')}
      <div class="span2 btns"><button class="primary">Save</button><button type="button" data-act="closeModal">Cancel</button></div></form>`);
  };
  const bankRow = (n, d) => `<div class="bs-row"><input name="bankName" placeholder="Bank / account (e.g. HDFC Bank 1234)" value="${esc(n)}"><input type="date" name="bankTill" value="${esc(d || '')}" max="${today()}"><button type="button" class="sm" data-act="bsDelBank" title="Remove">✕</button></div>`;

  Object.assign(A, {
    bsMark: ({ id }) => BS.markForm(id),
    bsAddBank: () => document.getElementById('bsBanks')?.insertAdjacentHTML('beforeend', bankRow('', '')),
    bsDelBank: (_, el) => el?.closest('.bs-row')?.remove(),
    bsSync: ({ id }) => guard(async () => { const c = S.clients.find(x => x.id === id); try { const n = await syncOne(c); toast(`${dispName(c)}: read ${n} vouchers from Tally`); } finally { busy(false); } render(); }),
    bsSyncAll: () => guard(async () => {
      let list; try { list = (await tallyCompanies(opt())).map(x => x.name || x); } catch (e) { throw new Error('Could not reach Tally: ' + e.message); }
      if (!list.length) throw new Error('No company is open in Tally.');
      let ok = 0; const miss = [];
      try {
        for (const c of S.clients.filter(x => !isItrOnly(x))) {
          const co = await companyFor(c, list);
          if (!co || !list.includes(co)) continue;
          try { await syncOne(c, list); ok++; } catch (e) { miss.push(dispName(c) + ': ' + e.message); }
        }
      } finally { busy(false); }
      render();
      toast(ok ? `Updated ${ok} client${ok === 1 ? '' : 's'} from Tally${miss.length ? ` · ${miss.length} failed` : ''}` : 'None of the companies open in Tally matched a client. Set the Tally company in Clients first.', 8000);
    }),
    bsAsk: ({ id }) => openDataRequest(id),
  });
  Object.assign(F, {
    bsSave: (fd, form) => guard(async () => {
      const c = S.clients.find(x => x.id === form.dataset.id), old = bt(c), bank = {};
      const names = fd.getAll('bankName'), dates = fd.getAll('bankTill');
      names.forEach((n, i) => { n = n.trim(); if (n) bank[n] = dates[i] || ''; });
      await save(c, { ...old, bank, sales: fd.get('sales') || '', purchase: fd.get('purchase') || '', journal: fd.get('journal') || '', src: 'manual' });
      closeModal(); render();
    }, 'Saved'),
  });
  Object.assign(C, {
    bsF: el => { st()[el.dataset.k] = el.value; render(); },
  });
  BS.onInput = el => { if (el.id === 'bsQ') { st().q = el.value; render(); const i = document.getElementById('bsQ'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } return true; } return false; };
  return BS;
}
