// Books → Ask AI: type an instruction ("paid 25,000 rent to Sharma Properties from HDFC on 3 Nov") and the AI turns
// it into Tally vouchers using this client's own ledgers. Nothing goes to Tally until you click Post on the voucher.
import { tallyImport, tallyEsc } from './tally.js';

const r2 = v => Math.round((+v || 0) * 100) / 100;
const inr = v => (+v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ymd = iso => String(iso || '').replace(/-/g, '');
const ls = { get: k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } } };
const VTYPES = ['Payment', 'Receipt', 'Contra', 'Journal', 'Sales', 'Purchase', 'Credit Note', 'Debit Note'];

export function initAiChat(ctx) {
  const { S, A, C, F, esc, toast, guard, render, isoToDisp, busy, k } = ctx;
  const AI = {};
  const st = () => { const s = k.st(); s.chat ||= {}; return (s.chat[s.cid] ||= { msgs: [], busy: false }); };

  function system() {
    const c = k.client(), led = k.L();
    const list = led.map(l => `${l.n} | ${l.r || l.p}${l.g ? ' | GSTIN ' + l.g : ''}${l.d ? ' | GST ' + l.d : ''}`).slice(0, 2500).join('\n');
    const t = new Date(), today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    return `You are the accounting assistant of a chartered accountant's office in India. You prepare TallyPrime vouchers for the client company below from the user's instruction.
Company: ${k.dispName(c)}${k.own(c)[0] ? ` (GSTIN ${k.own(c)[0]})` : ''}. Tally company: ${k.meta().company || ''}. Today is ${today}. Indian financial year April–March; a date without a year means the most recent such date not after today.

Ledgers in this Tally company (name | group path | GSTIN | GST duty):
${list}

Rules:
- Use EXACT ledger names from the list. If a needed party/expense ledger does not exist, use a sensible new name and add it to "new_ledgers" with its Tally group (e.g. Sundry Creditors, Sundry Debtors, Indirect Expenses, Direct Expenses, Indirect Incomes, Fixed Assets, Loans & Advances (Asset), Unsecured Loans).
- Voucher type: one of ${VTYPES.join(', ')}. Bank/cash paid out = Payment, received = Receipt, bank↔bank or bank↔cash = Contra, everything else (provisions, adjustments, depreciation, TDS, expenses booked on credit) = Journal; GST invoices with a party = Purchase / Sales (accounting invoice).
- Each voucher must balance: total debit = total credit. Split GST: intra-state CGST+SGST at half rate each, inter-state IGST (compare the party's state code in its GSTIN with the company's). TDS: deduct from the party and credit the TDS payable ledger when the user mentions it.
- Several entries in one instruction → several vouchers. If something essential is missing or ambiguous (amount, which bank, which party), ask ONE short question instead of guessing, with "vouchers": [].
- Narration: short and clear, like an accountant would write it.

Reply with JSON only:
{"reply":"one or two sentences to the user","vouchers":[{"type":"Payment","date":"YYYY-MM-DD","ref":"","narration":"","lines":[{"ledger":"","dr":0,"cr":0}]}],"new_ledgers":[{"name":"","group":"","gstin":"","state":""}]}`;
  }
  async function ask(text) {
    const key = ls.get('cadesk.aiKey'); if (!key) throw new Error('Add your Anthropic API key first (Bookkeeping → Reading documents → add Anthropic API key).');
    const s = st();
    s.msgs.push({ role: 'user', text });
    const messages = s.msgs.filter(m => m.role === 'user' || m.raw).slice(-12).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.role === 'user' ? m.text : m.raw }));
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: ls.get('cadesk.aiModel') || 'claude-sonnet-5-5', max_tokens: 4000, system: system(), messages }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`AI: ${j?.error?.message || r.status}`);
    const raw = (j.content || []).map(c => c.text || '').join('');
    let out; try { out = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { out = { reply: raw.trim(), vouchers: [] }; }
    const vs = (out.vouchers || []).map((v, i) => ({ ...v, id: `${Date.now()}_${i}`, lines: (v.lines || []).map(l => ({ ledger: String(l.ledger || '').trim(), dr: r2(l.dr), cr: r2(l.cr) })).filter(l => l.ledger && (l.dr || l.cr)), status: '' }));
    s.msgs.push({ role: 'ai', text: out.reply || '', raw, vouchers: vs, newLedgers: out.new_ledgers || [] });
  }

  const check = (v, nl) => {
    const dr = r2(v.lines.reduce((a, l) => a + l.dr, 0)), cr = r2(v.lines.reduce((a, l) => a + l.cr, 0)), p = [];
    if (Math.abs(dr - cr) > 0.01) p.push(`Debit ${inr(dr)} ≠ credit ${inr(cr)}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date || '')) p.push('date');
    if (!VTYPES.includes(v.type)) p.push('voucher type');
    const unknown = v.lines.map(l => l.ledger).filter(n => !k.led(n) && !(nl || []).some(x => x.name === n));
    if (unknown.length) p.push('not in Tally: ' + unknown.join(', '));
    return { dr, cr, p };
  };
  function vCard(m, v) {
    const c = check(v, m.newLedgers);
    const news = (m.newLedgers || []).filter(x => v.lines.some(l => l.ledger === x.name) && !k.led(x.name));
    return `<div class="ai-v ${v.status}"><div class="row-between"><b>${esc(v.type)} · ${isoToDisp(v.date) || '—'}${v.ref ? ` · ${esc(v.ref)}` : ''}</b>
        <span>${v.status === 'posted' ? '<span class="tag green">Posted to Tally</span>' : v.status === 'skipped' ? '<span class="tag">Discarded</span>' : c.p.length ? `<span class="tag red">${esc(c.p.join(' · '))}</span>` : '<span class="tag green">Balanced</span>'}</span></div>
      <table class="tbl ai-t"><thead><tr><th>Ledger</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>
      ${v.lines.map(l => `<tr><td>${esc(l.ledger)}${k.led(l.ledger) ? '' : ' <span class="tag amber">new</span>'}</td><td class="num">${l.dr ? inr(l.dr) : ''}</td><td class="num">${l.cr ? inr(l.cr) : ''}</td></tr>`).join('')}
      <tr class="tot"><td>Total</td><td class="num">${inr(c.dr)}</td><td class="num">${inr(c.cr)}</td></tr></tbody></table>
      ${v.narration ? `<p class="small muted">Narration: ${esc(v.narration)}</p>` : ''}
      ${news.length ? `<p class="small amber-t">New ledger${news.length === 1 ? '' : 's'} created first: ${news.map(x => `${esc(x.name)} (${esc(x.group)})`).join(', ')}</p>` : ''}
      ${v.status ? '' : `<div class="btns"><button class="sm primary" data-act="aiPost" data-id="${v.id}" ${c.p.length ? 'disabled' : ''}>Post to Tally</button><button class="sm" data-act="aiSkip" data-id="${v.id}">Discard</button></div>`}</div>`;
  }
  AI.view = () => {
    const s = st(), key = ls.get('cadesk.aiKey'), m = k.meta();
    return `<div class="card ai-chat"><div class="row-between wrap"><h2>Ask AI to pass entries</h2><span class="small muted">${m.company ? `Tally: <b>${esc(m.company)}</b> · ${k.L().length} ledgers` : '<span class="red">Choose and sync the Tally company first</span>'}</span></div>
      <div class="ai-log" id="aiLog">${s.msgs.length ? s.msgs.map(x => x.role === 'user' ? `<div class="ai-m me">${esc(x.text)}</div>` : `<div class="ai-m bot">${esc(x.text || '')}${(x.vouchers || []).map(v => vCard(x, v)).join('')}</div>`).join('') : `<div class="ai-hint"><b>Type what to enter, the way you would tell your accountant.</b><br>
        <span>“Paid 25,000 office rent for November to Sharma Properties from HDFC on 3 Nov, TDS 10%”</span><span>“Sales to ABC Ltd 10,000 + 18% GST, invoice 45, 5 Nov”</span><span>“Provision for audit fees 50,000 for FY 2025-26”</span><span>“Withdrew 20,000 cash from ICICI today”</span>
        <small>The AI uses this client's Tally ledgers. Every voucher is shown first – nothing reaches Tally until you click Post.</small></div>`}${s.busy ? '<div class="ai-m bot"><i>Thinking…</i></div>' : ''}</div>
      <form data-form="aiSend" class="ai-in"><textarea name="q" rows="2" placeholder="${key ? 'e.g. Paid electricity bill 4,320 from HDFC yesterday' : 'Add your Anthropic API key first (Reading documents → add key)'}" ${key && m.syncedAt ? '' : 'disabled'}></textarea>
        <button class="primary" ${key && m.syncedAt && !s.busy ? '' : 'disabled'}>Send</button>${s.msgs.length ? '<button type="button" class="sm ghost" data-act="aiClear">Clear</button>' : ''}</form></div>`;
  };
  const find = id => { for (const m of st().msgs) for (const v of m.vouchers || []) if (v.id === id) return { m, v }; return {}; };
  async function postOne(m, v) {
    const company = k.meta().company;
    for (const x of (m.newLedgers || []).filter(x => v.lines.some(l => l.ledger === x.name) && !k.led(x.name))) {
      const bw = /sundry/i.test(x.group);
      const xml = `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${tallyEsc(x.name)}" ACTION="Create"><NAME.LIST><NAME>${tallyEsc(x.name)}</NAME></NAME.LIST><PARENT>${tallyEsc(x.group)}</PARENT><ISBILLWISEON>${bw ? 'Yes' : 'No'}</ISBILLWISEON>${x.state ? `<LEDSTATENAME>${tallyEsc(x.state)}</LEDSTATENAME>` : ''}${x.gstin ? `<PARTYGSTIN>${tallyEsc(x.gstin)}</PARTYGSTIN><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>` : ''}</LEDGER></TALLYMESSAGE>`;
      const r = await tallyImport(company, 'All Masters', xml, k.opt());
      if (r.errors && !/already exists/i.test(r.lineErrors.join(' '))) throw new Error(`Could not create ledger ${x.name}: ${r.lineErrors[0] || 'error'}`);
      k.addLedger({ n: x.name, p: x.group, r: x.group, g: x.gstin || '', s: x.state || '' });
    }
    const E = l => { const a = l.dr ? -l.dr : l.cr; return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${tallyEsc(l.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${a < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${r2(a).toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`; };
    const xml = `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${tallyEsc(v.type)}" ACTION="Create" OBJVIEW="Accounting Voucher View"><DATE>${ymd(v.date)}</DATE><EFFECTIVEDATE>${ymd(v.date)}</EFFECTIVEDATE><VOUCHERTYPENAME>${tallyEsc(v.type)}</VOUCHERTYPENAME>${v.ref ? `<REFERENCE>${tallyEsc(v.ref)}</REFERENCE>` : ''}<NARRATION>${tallyEsc((v.narration || '') + ' [CA Desk AI]')}</NARRATION>${v.lines.map(E).join('')}</VOUCHER></TALLYMESSAGE>`;
    const r = await tallyImport(company, 'Vouchers', xml, k.opt());
    if (!r.created || r.errors) throw new Error(r.lineErrors[0] || 'Tally did not create the voucher');
  }
  const scroll = () => setTimeout(() => { const l = document.getElementById('aiLog'); if (l) l.scrollTop = l.scrollHeight; }, 30);
  Object.assign(F, {
    aiSend: fd => { const q = String(fd.get('q') || '').trim(); if (!q) return; const s = st(); s.busy = true; render(); scroll();
      ask(q).catch(e => { s.msgs.push({ role: 'ai', text: '⚠ ' + e.message }); }).finally(() => { s.busy = false; render(); scroll(); document.querySelector('.ai-in textarea')?.focus(); }); },
  });
  Object.assign(A, {
    aiClear: () => { st().msgs = []; render(); },
    aiSkip: ({ id }) => { const { v } = find(id); if (v) v.status = 'skipped'; render(); },
    aiPost: ({ id }) => { const { m, v } = find(id); if (!m || !confirm(`Post this ${v.type} of ${inr(check(v, m.newLedgers).dr)} to Tally company “${k.meta().company}”?`)) return;
      guard(async () => { busy(true, 'Posting to Tally…'); try { await postOne(m, v); v.status = 'posted'; } finally { busy(false); } render(); scroll(); }, 'Posted to Tally'); },
  });
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && e.target.matches?.('.ai-in textarea')) { e.preventDefault(); e.target.form?.requestSubmit(); } });
  return AI;
}
