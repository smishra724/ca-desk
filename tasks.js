// Task manager — departments → work categories (docs required / weighted activities / outcome docs),
// tasks with checklist progress, board & list views, reassign log, notes, timesheet, task-wise fees,
// bulk generation from the compliance calendar, and a read-only view for clients.

const STATUSES = ['Not started', 'In progress', 'Waiting on client', 'Under review', 'Completed', 'Cancelled'];
const BOARD = STATUSES.filter(s => s !== 'Cancelled');
const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];

const cat = (id, name, docs, acts, outs) => ({ id, name, docs, acts: acts.map(([n, w]) => ({ name: n, weight: w })), outs });
export const DEFAULT_WORKFLOW = {
  departments: [
    { id: 'gst', name: 'GST', assignee: '', categories: [
      cat('GSTREG', 'GST Registration', ['PAN', 'Aadhaar', 'Photograph', 'Address proof / electricity bill', 'Rent agreement / NOC', 'Bank proof'],
        [['Collect documents', 10], ['File REG-01', 30], ['Reply to clarification', 20], ['Approval received', 40]], ['GST certificate (REG-06)']),
      cat('GSTR1', 'GSTR-1 / IFF', ['Sales register / invoices', 'Credit & debit notes'],
        [['Collect sales data', 20], ['Reconcile with books', 20], ['Prepare & upload', 40], ['File with EVC/DSC', 20]], ['GSTR-1 ARN']),
      cat('GSTR3B', 'GSTR-3B', ['Purchase register', 'Expense bills'],
        [['Download GSTR-2B', 15], ['ITC reconciliation', 35], ['Compute liability', 20], ['Payment challan', 15], ['File return', 15]], ['GSTR-3B ARN', 'Payment challan']),
      cat('PMT06', 'GST payment (PMT-06)', [], [['Compute liability', 50], ['Generate & pay challan', 50]], ['Challan']),
      cat('CMP08', 'CMP-08', ['Turnover for the quarter'], [['Compute tax', 50], ['File CMP-08', 50]], ['CMP-08 ARN']),
      cat('GSTR9', 'GSTR-9 annual return', ['Books of accounts', 'Monthly returns'], [['Reconcile returns with books', 50], ['Prepare GSTR-9', 30], ['File', 20]], ['GSTR-9 ARN']),
      cat('GSTR4', 'GSTR-4 annual return', ['Purchase details'], [['Prepare', 60], ['File', 40]], ['GSTR-4 ARN']),
    ]},
    { id: 'it', name: 'Income Tax', assignee: '', categories: [
      cat('ITR', 'ITR filing', ['Form 16 / 16A', 'Bank statements', 'Investment proofs (80C/80D)', 'Capital gains statement', 'Books / P&L (business)'],
        [['Download AIS / 26AS / TIS', 10], ['Compute income', 30], ['Review with client', 15], ['File ITR', 30], ['E-verify', 15]], ['ITR-V acknowledgement', 'Computation']),
      cat('3CD', 'Tax audit', ['Books of accounts', 'Ledgers', 'Fixed asset register', 'Stock statement'],
        [['Audit checks', 50], ['Prepare 3CD', 30], ['Upload & client acceptance', 20]], ['Form 3CA/3CB-3CD acknowledgement']),
      cat('ADV', 'Advance tax', ['Estimated income'], [['Estimate liability', 50], ['Pay challan 280', 50]], ['Challan 280']),
    ]},
    { id: 'tds', name: 'TDS', assignee: '', categories: [
      cat('TDSPAY', 'TDS / TCS payment', ['Expense / salary details'], [['Compute TDS', 50], ['Pay challan 281', 50]], ['Challan 281']),
      cat('TDSRET', 'TDS / TCS return', ['Deductee details & PAN', 'Challans'],
        [['Prepare return', 40], ['Validate FVU', 20], ['File return', 30], ['Issue Form 16/16A', 10]], ['Token number', 'Form 16 / 16A']),
    ]},
    { id: 'roc', name: 'Company Law / ROC', assignee: '', categories: [
      cat('AOC4', 'AOC-4 (financials)', ['Signed financials', 'Board report', 'Audit report'], [['Prepare form', 50], ['DSC & file', 50]], ['SRN / challan']),
      cat('MGT7', 'MGT-7 / 7A (annual return)', ['Shareholding', 'Board & AGM details'], [['Prepare form', 50], ['DSC & file', 50]], ['SRN / challan']),
      cat('DIR3', 'DIR-3 KYC', ['Director PAN, Aadhaar, mobile, email'], [['OTP verification', 50], ['File', 50]], ['SRN']),
      cat('DPT3', 'DPT-3', ['Loan details', 'Auditor certificate'], [['Prepare', 50], ['File', 50]], ['SRN']),
      cat('MSME1', 'MSME-1', ['MSME creditors outstanding > 45 days'], [['Prepare', 50], ['File', 50]], ['SRN']),
      cat('LLP8', 'LLP Form 8', ['Statement of accounts & solvency'], [['Prepare', 50], ['DSC & file', 50]], ['SRN']),
      cat('LLP11', 'LLP Form 11', ['Partner contribution details'], [['Prepare', 50], ['DSC & file', 50]], ['SRN']),
      cat('INC', 'Company / LLP incorporation', ['Director/partner KYC', 'Registered office proof', 'DSC'],
        [['Name reservation', 20], ['Draft MOA/AOA / agreement', 30], ['File SPICe+ / FiLLiP', 30], ['Certificate received', 20]], ['Certificate of Incorporation', 'PAN / TAN']),
    ]},
    { id: 'payroll', name: 'Payroll', assignee: '', categories: [
      cat('EPF', 'EPF ECR & payment', ['Attendance / salary sheet'], [['Prepare ECR', 50], ['Upload & pay', 50]], ['ECR receipt / TRRN']),
      cat('ESIC', 'ESIC contribution', ['Attendance / salary sheet'], [['Monthly contribution', 50], ['Pay challan', 50]], ['Challan']),
    ]},
    { id: 'acc', name: 'Accounting', assignee: '', categories: [
      cat('BOOKS', 'Monthly bookkeeping', ['Bank statements', 'Sales & purchase bills', 'Expense vouchers'],
        [['Voucher entry', 60], ['Bank reconciliation', 30], ['Review', 10]], ['MIS / trial balance']),
      cat('FS', 'Finalisation of accounts', ['Trial balance', 'Closing stock', 'Confirmations'],
        [['Adjustments & provisions', 40], ['Prepare financials', 40], ['Review & sign', 20]], ['Signed financial statements']),
    ]},
    { id: 'gen', name: 'General', assignee: '', categories: [ cat('GEN', 'General work', [], [['Work done', 100]], []) ]},
  ],
  staff: [],
};

// compliance-calendar key prefix → work category id
const catForKey = key => {
  const p = key.split('-')[0].replace(/H\d$/, '');
  return ({ IFF: 'GSTR1', ADV1: 'ADV', ADV2: 'ADV', ADV3: 'ADV', ADV4: 'ADV' })[p] || p;
};

export function initTasks(ctx) {
  const { S, A, F, C, esc, toast, modal, closeModal, guard, fmtDate, isoToDisp, todayISO, dueItems, isAdmin, $, render, fs } = ctx;
  const { doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc, collection, query, where } = fs;
  const db = ctx.db;
  const T = {};
  const nowISO = () => new Date().toISOString();
  const me = () => S.profile?.name || S.profile?.email || 'Owner';

  S.wf = null; S.tasks = []; S.task = null;
  S.tf = { q: '', assignee: '', dept: '', status: 'open', due: '', star: false, mode: 'board' };

  /* ---------- data ---------- */
  T.load = async () => {
    const w = await getDoc(doc(db, 'meta', 'workflow'));
    S.wf = w.exists() ? w.data() : structuredClone(DEFAULT_WORKFLOW);
    if (!S.wf.staff) S.wf.staff = [];
    const snap = await getDocs(collection(db, 'tasks'));
    S.tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  };
  T.loadForClient = async cid => {
    const snap = await getDocs(query(collection(db, 'tasks'), where('clientId', '==', cid)));
    S.tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  };
  const saveWf = () => setDoc(doc(db, 'meta', 'workflow'), JSON.parse(JSON.stringify(S.wf)));
  const findCat = id => { for (const d of S.wf?.departments || []) { const c = d.categories.find(c => c.id === id); if (c) return { d, c }; } return null; };
  const nextNo = async () => {
    const r = doc(db, 'meta', 'counters'); const s = await getDoc(r);
    const n = (s.exists() ? s.data().task || 0 : 0) + 1; await setDoc(r, { task: n }, { merge: true }); return n;
  };
  const tno = t => 'T-' + String(t.no || 0).padStart(4, '0');
  const progress = t => {
    const acts = t.list?.acts || []; const tot = acts.reduce((s, a) => s + (+a.weight || 0), 0);
    if (!tot) return t.status === 'Completed' ? 100 : 0;
    return Math.round(acts.reduce((s, a, i) => s + (t.done?.acts?.[i] ? +a.weight || 0 : 0), 0) / tot * 100);
  };
  const overdue = t => t.due && t.due < todayISO() && !['Completed', 'Cancelled'].includes(t.status);
  const staffOpts = (v, blank = 'Unassigned') => `<option value="">${blank}</option>` + (S.wf?.staff || []).map(s => `<option ${s === v ? 'selected' : ''}>${esc(s)}</option>`).join('');
  const clientName = cid => S.clients.find(c => c.id === cid)?.name || '';

  async function createTask(data) {
    const found = findCat(data.catId);
    const t = {
      no: await nextNo(), clientId: data.clientId, clientName: clientName(data.clientId) || data.clientName || '',
      deptId: found?.d.id || '', dept: found?.d.name || '', catId: data.catId, cat: found?.c.name || data.catId,
      title: data.title || found?.c.name || 'Task', period: data.period || '', due: data.due || '',
      assignee: data.assignee ?? (found?.d.assignee || ''), priority: data.priority || 'Normal', status: 'Not started',
      list: { docs: [...(found?.c.docs || [])], acts: (found?.c.acts || []).map(a => ({ ...a })), outs: [...(found?.c.outs || [])] },
      done: { docs: [], acts: [], outs: [] }, filingKey: data.filingKey || '', fee: +data.fee || 0, billed: false, received: 0,
      notes: [], time: [], log: [{ at: nowISO(), by: me(), text: 'Task created' }], starred: false, createdAt: nowISO(), updatedAt: nowISO(),
    };
    const r = await addDoc(collection(db, 'tasks'), t);
    S.tasks.push({ id: r.id, ...t }); return r.id;
  }
  async function patch(id, upd, logText) {
    const t = S.tasks.find(x => x.id === id);
    const log = logText ? [...(t.log || []), { at: nowISO(), by: me(), text: logText }] : t.log;
    const data = { ...upd, log, updatedAt: nowISO() };
    await updateDoc(doc(db, 'tasks', id), data); Object.assign(t, data);
  }
  T.deleteForClient = async cid => { for (const t of S.tasks.filter(t => t.clientId === cid)) await deleteDoc(doc(db, 'tasks', t.id)); S.tasks = S.tasks.filter(t => t.clientId !== cid); };

  // completing a task generated from the compliance calendar marks that return as filed
  async function syncFiling(t, ack) {
    if (!t.filingKey || !t.clientId) return;
    const data = { status: 'filed', filedOn: todayISO(), ack: ack || t.ack || '', remarks: `Task ${tno(t)}`, by: me(), at: nowISO() };
    await setDoc(doc(db, 'clients', t.clientId, 'filings', t.filingKey), data);
    S.allFilings[`${t.clientId}|${t.filingKey}`] = data; if (S.cid === t.clientId) S.filings[t.filingKey] = data;
  }

  /* ---------- filtering ---------- */
  function filtered() {
    const f = S.tf, q = f.q.toLowerCase(), today = todayISO();
    const wk = new Date(); wk.setDate(wk.getDate() + 7); const wkISO = wk.toISOString().slice(0, 10);
    const mo = new Date(); mo.setMonth(mo.getMonth() + 1, 0); const moISO = mo.toISOString().slice(0, 10);
    return S.tasks.filter(t =>
      (!q || [tno(t), t.clientName, t.title, t.cat, t.period, t.assignee].some(v => (v || '').toLowerCase().includes(q))) &&
      (!f.assignee || (f.assignee === '_none' ? !t.assignee : t.assignee === f.assignee)) &&
      (!f.dept || t.deptId === f.dept) &&
      (f.status === 'all' || (f.status === 'open' ? !['Completed', 'Cancelled'].includes(t.status) : t.status === f.status)) &&
      (!f.star || t.starred) &&
      (!f.due || (f.due === 'overdue' ? overdue(t) : f.due === 'week' ? t.due && t.due <= wkISO : f.due === 'month' ? t.due && t.due <= moISO
        : f.due === 'unbilled' ? t.status === 'Completed' && !t.billed && t.fee > 0 : true))
    ).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.no - b.no);
  }

  /* ---------- views ---------- */
  const card = t => {
    const p = progress(t);
    return `<div class="tcard ${overdue(t) ? 'od' : ''}" draggable="true" data-tid="${t.id}" data-act="openTask" data-id="${t.id}">
      <div class="tc-h"><span class="mono tiny">${tno(t)}</span>${t.starred ? '<span>★</span>' : ''}${t.priority === 'High' || t.priority === 'Urgent' ? `<span class="tag ${t.priority === 'Urgent' ? 'red' : 'amber'}">${t.priority}</span>` : ''}</div>
      <b>${esc(t.clientName || '—')}</b>
      <div class="small">${esc(t.title)}${t.period ? ` · ${esc(t.period)}` : ''}</div>
      <div class="bar"><i style="width:${p}%"></i></div>
      <div class="tc-f"><span class="${overdue(t) ? 'red' : 'muted'} small">${t.due ? 'Due ' + isoToDisp(t.due) : 'No due date'}</span>
        <span class="avatar" title="${esc(t.assignee || 'Unassigned')}">${esc(initials(t.assignee))}</span></div>
    </div>`;
  };
  const initials = n => n ? n.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() : '—';

  T.vTasks = () => {
    const f = S.tf, list = filtered();
    const tabs = [['board', 'Board'], ['list', 'List'], ['time', 'Timesheet'], ['billing', 'Billing']]
      .map(([m, l]) => `<button class="${f.mode === m ? 'on' : ''}" data-act="taskMode" data-m="${m}">${l}</button>`).join('');
    const filters = `<div class="filters">
      <input id="tq" placeholder="Search task no, client, work, period…" value="${esc(f.q)}">
      <select data-change="tf" data-k="assignee"><option value="">All staff</option><option value="_none" ${f.assignee === '_none' ? 'selected' : ''}>Unassigned</option>${(S.wf.staff || []).map(s => `<option ${s === f.assignee ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <select data-change="tf" data-k="dept"><option value="">All departments</option>${S.wf.departments.map(d => `<option value="${d.id}" ${d.id === f.dept ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
      <select data-change="tf" data-k="status">${[['open', 'Open tasks'], ['all', 'All statuses'], ...STATUSES.map(s => [s, s])].map(([v, l]) => `<option value="${v}" ${v === f.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select data-change="tf" data-k="due">${[['', 'Any due date'], ['overdue', 'Overdue'], ['week', 'Due in 7 days'], ['month', 'Due this month'], ['unbilled', 'Completed, not billed']].map(([v, l]) => `<option value="${v}" ${v === f.due ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label class="chk"><input type="checkbox" data-change="tf" data-k="star" ${f.star ? 'checked' : ''}> ★ Bookmarked</label>
    </div>`;
    let bodyHtml = '';
    if (f.mode === 'board') {
      bodyHtml = `<div class="board">${BOARD.filter(s => f.status === 'open' ? s !== 'Completed' : true).map(s => {
        const col = list.filter(t => t.status === s);
        return `<div class="col" data-status="${s}"><div class="col-h">${s} <span class="muted">${col.length}</span></div>${col.map(card).join('') || '<div class="muted tiny empty">Drop tasks here</div>'}</div>`;
      }).join('')}</div>`;
    } else if (f.mode === 'list') {
      bodyHtml = `<table class="tbl"><thead><tr><th>No.</th><th>Client</th><th>Work</th><th>Period</th><th>Due</th><th>Assignee</th><th>Status</th><th>Progress</th></tr></thead><tbody>
        ${list.map(t => `<tr class="click ${overdue(t) ? 'od2' : ''}" data-act="openTask" data-id="${t.id}"><td class="mono nowrap">${t.starred ? '★ ' : ''}${tno(t)}</td>
          <td>${esc(t.clientName)}</td><td>${esc(t.title)}<div class="muted tiny">${esc(t.dept)}</div></td><td>${esc(t.period)}</td>
          <td class="nowrap ${overdue(t) ? 'red' : ''}">${isoToDisp(t.due)}</td><td>${esc(t.assignee || '—')}</td>
          <td>${statusTag(t.status)}</td><td><div class="bar sm"><i style="width:${progress(t)}%"></i></div><span class="tiny muted">${progress(t)}%</span></td></tr>`).join('')
          || '<tr><td colspan="8" class="muted empty">No tasks match.</td></tr>'}</tbody></table>`;
    } else if (f.mode === 'time') bodyHtml = vTime();
    else bodyHtml = vBilling(list);
    const open = S.tasks.filter(t => !['Completed', 'Cancelled'].includes(t.status));
    return `
    <section class="card">
      <div class="row-between wrap"><h2>Tasks <span class="muted">(${open.length} open · <span class="red">${open.filter(overdue).length} overdue</span>)</span></h2>
        <div class="btns">${isAdmin() ? `<button class="primary" data-act="newTask">+ New task</button>
          <button data-act="genTasks">Generate from compliance calendar</button>
          <button data-act="go" data-v="workflow">Workflow & staff</button>` : ''}</div></div>
      <div class="tabs inner">${tabs}</div>
      ${['board', 'list', 'billing'].includes(f.mode) ? filters : ''}
      ${bodyHtml}
    </section>`;
  };
  const statusTag = s => `<span class="tag ${({ 'Completed': 'green', 'Waiting on client': 'amber', 'Under review': 'blue', 'In progress': 'blue', 'Cancelled': '' })[s] ?? ''}">${esc(s)}</span>`;

  function vTime() {
    const from = S.tf.tFrom || todayISO().slice(0, 8) + '01', to = S.tf.tTo || todayISO();
    const rows = [];
    for (const t of S.tasks) for (const e of t.time || []) if (e.date >= from && e.date <= to) rows.push({ ...e, t });
    rows.sort((a, b) => b.date.localeCompare(a.date));
    const sum = key => { const m = {}; for (const r of rows) m[key(r)] = (m[key(r)] || 0) + (+r.mins || 0); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
    const hrs = m => (m / 60).toFixed(1);
    const tbl = (title, data) => `<div><h3>${title}</h3><table class="tbl"><tbody>${data.map(([k, m]) => `<tr><td>${esc(k)}</td><td class="nowrap">${hrs(m)} h</td></tr>`).join('') || '<tr><td class="muted">No time logged</td></tr>'}</tbody></table></div>`;
    return `<div class="filters"><label>From<input type="date" data-change="tf" data-k="tFrom" value="${from}"></label><label>To<input type="date" data-change="tf" data-k="tTo" value="${to}"></label>
      <span class="muted small">Total: <b>${hrs(rows.reduce((s, r) => s + (+r.mins || 0), 0))} h</b></span></div>
      <div class="grid3">${tbl('By staff', sum(r => r.by))}${tbl('By client', sum(r => r.t.clientName || '—'))}${tbl('By department', sum(r => r.t.dept || '—'))}</div>
      <h3>Entries</h3><table class="tbl"><thead><tr><th>Date</th><th>Staff</th><th>Task</th><th>Client</th><th>Hours</th><th>Note</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="click" data-act="openTask" data-id="${r.t.id}"><td class="nowrap">${isoToDisp(r.date)}</td><td>${esc(r.by)}</td><td>${tno(r.t)} ${esc(r.t.title)}</td><td>${esc(r.t.clientName)}</td><td>${hrs(r.mins)}</td><td>${esc(r.note)}</td></tr>`).join('')
        || '<tr><td colspan="6" class="muted empty">No entries in this period. Log time from inside a task.</td></tr>'}</tbody></table>`;
  }
  function vBilling(list) {
    const rows = list.filter(t => t.fee > 0 || t.received > 0);
    const tot = k => rows.reduce((s, t) => s + (+t[k] || 0), 0);
    const inr = n => '₹' + (+n || 0).toLocaleString('en-IN');
    return `<div class="stats"><div class="stat"><b>${inr(tot('fee'))}</b><span>Fees on these tasks</span></div>
      <div class="stat amber"><b>${inr(rows.filter(t => !t.billed).reduce((s, t) => s + t.fee, 0))}</b><span>Not yet billed</span></div>
      <div class="stat"><b>${inr(tot('received'))}</b><span>Received</span></div>
      <div class="stat red"><b>${inr(tot('fee') - tot('received'))}</b><span>Outstanding</span></div></div>
      <table class="tbl"><thead><tr><th>No.</th><th>Client</th><th>Work</th><th>Status</th><th>Fee</th><th>Billed</th><th>Received</th><th>Balance</th></tr></thead><tbody>
      ${rows.map(t => `<tr class="click" data-act="openTask" data-id="${t.id}"><td class="mono">${tno(t)}</td><td>${esc(t.clientName)}</td><td>${esc(t.title)} ${esc(t.period)}</td>
        <td>${statusTag(t.status)}</td><td>${inr(t.fee)}</td><td>${t.billed ? '<span class="tag green">Billed</span>' : '<span class="tag">No</span>'}</td><td>${inr(t.received)}</td><td>${inr(t.fee - t.received)}</td></tr>`).join('')
        || '<tr><td colspan="8" class="muted empty">Add a fee inside a task to track billing.</td></tr>'}</tbody></table>`;
  }

  /* ---------- task detail ---------- */
  T.vTask = () => {
    const t = S.tasks.find(x => x.id === S.task); if (!t) return '<p>Task not found.</p>';
    const adm = isAdmin(), p = progress(t), dis = adm ? '' : 'disabled';
    const checks = (sec, title, items) => items.length ? `<div class="chkgrp"><h3>${title}</h3>${items.map((it, i) => {
      const name = typeof it === 'string' ? it : it.name;
      return `<label class="chk"><input type="checkbox" data-change="tcheck" data-sec="${sec}" data-i="${i}" ${t.done?.[sec]?.[i] ? 'checked' : ''} ${dis}> ${esc(name)}${typeof it === 'object' ? ` <span class="muted tiny">${it.weight}%</span>` : ''}</label>`;
    }).join('')}</div>` : '';
    return `
    <button class="link back" data-act="go" data-v="${adm ? 'tasks' : 'client'}">← ${adm ? 'All tasks' : 'Back'}</button>
    <section class="card head">
      <div class="row-between wrap"><div>
        <div class="muted mono small">${tno(t)} · ${esc(t.dept)}</div>
        <h1>${esc(t.title)}${t.period ? ` <span class="muted">— ${esc(t.period)}</span>` : ''}</h1>
        <div class="chips"><span>${esc(t.clientName || 'No client')}</span>${statusTag(t.status)}${overdue(t) ? '<span class="tag red">Overdue</span>' : ''}</div></div>
        ${adm ? `<div class="btns"><button data-act="starTask">${t.starred ? '★ Bookmarked' : '☆ Bookmark'}</button>
          <button data-act="fwdTask">Forward / reassign</button>
          ${t.clientId ? `<button data-act="open" data-id="${t.clientId}" data-tab="master">Open client</button>` : ''}</div>` : ''}
      </div>
      <div class="bar big"><i style="width:${p}%"></i></div><div class="muted small">${p}% complete</div>
    </section>
    <div class="split">
      <section class="card">
        <h2>Checklist</h2>
        ${checks('docs', 'Documents required from client', t.list?.docs || [])}
        ${checks('acts', 'Activities', t.list?.acts || [])}
        ${checks('outs', 'Outcome documents', t.list?.outs || [])}
        ${!(t.list?.docs?.length || t.list?.acts?.length || t.list?.outs?.length) ? '<p class="muted">No checklist for this work category.</p>' : ''}
        <h2 class="mt">Notes</h2>
        ${(t.notes || []).slice().reverse().map(n => `<div class="note"><div class="muted tiny">${esc(n.by)} · ${fmtDT(n.at)}</div>${esc(n.text).replace(/\n/g, '<br>')}</div>`).join('') || '<p class="muted small">No notes.</p>'}
        ${adm ? `<form data-form="taskNote" class="row"><input name="text" placeholder="Add a note — pending items, client reply, part payment…" required><button class="primary">Add</button></form>` : ''}
      </section>
      <section class="card">
        ${adm ? `<form data-form="taskEdit" class="grid">
          <label>Status<select name="status">${STATUSES.map(s => `<option ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
          <label>Assigned to<select name="assignee">${staffOpts(t.assignee)}</select></label>
          <label>Due date<input type="date" name="due" value="${esc(t.due)}"></label>
          <label>Priority<select name="priority">${PRIORITIES.map(s => `<option ${s === t.priority ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
          <label class="span2">Title<input name="title" value="${esc(t.title)}"></label>
          <label>Period<input name="period" value="${esc(t.period)}"></label>
          <label>ARN / acknowledgement<input name="ack" value="${esc(t.ack)}"></label>
          <label>Fee (₹)<input type="number" min="0" name="fee" value="${t.fee || ''}"></label>
          <label>Received (₹)<input type="number" min="0" name="received" value="${t.received || ''}"></label>
          <label class="chk span2"><input type="checkbox" name="billed" ${t.billed ? 'checked' : ''}> Bill raised</label>
          ${t.filingKey ? '<p class="muted small span2">Linked to the compliance calendar — completing this task marks the return as filed.</p>' : ''}
          <div class="span2 btns"><button class="primary">Save</button><button type="button" class="danger" data-act="delTask">Delete task</button></div>
        </form>` : `<dl class="dl one"><dt>Status</dt><dd>${statusTag(t.status)}</dd><dt>Due date</dt><dd>${isoToDisp(t.due) || '—'}</dd>
          ${t.ack ? `<dt>ARN / ack</dt><dd class="mono">${esc(t.ack)}</dd>` : ''}</dl>`}
        ${adm ? `<h2 class="mt">Time log <span class="muted small">${((t.time || []).reduce((s, e) => s + (+e.mins || 0), 0) / 60).toFixed(1)} h</span></h2>
        ${(t.time || []).map(e => `<div class="small">${isoToDisp(e.date)} · ${esc(e.by)} · <b>${(e.mins / 60).toFixed(1)} h</b> ${esc(e.note)}</div>`).join('')}
        <form data-form="taskTime" class="row wrap"><input type="date" name="date" value="${todayISO()}"><select name="by">${staffOpts(S.wf.staff?.[0] || '', 'Owner')}</select>
          <input type="number" name="hrs" step="0.25" min="0.25" placeholder="Hours" required style="width:90px"><input name="note" placeholder="What was done"><button>Log</button></form>
        <h2 class="mt">History</h2>
        <div class="log">${(t.log || []).slice().reverse().map(l => `<div class="small"><span class="muted tiny">${fmtDT(l.at)} · ${esc(l.by)}</span><br>${esc(l.text)}</div>`).join('')}</div>` : ''}
      </section>
    </div>`;
  };
  const fmtDT = s => { const d = new Date(s); return isNaN(d) ? '' : `${fmtDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  /* ---------- client tab & dashboard ---------- */
  T.tClientTasks = () => {
    const list = S.tasks.filter(t => t.clientId === S.cid && t.status !== 'Cancelled').sort((a, b) => (b.due || '').localeCompare(a.due || ''));
    const pendingDocs = [];
    for (const t of list) if (!['Completed', 'Cancelled'].includes(t.status)) (t.list?.docs || []).forEach((d, i) => { if (!t.done?.docs?.[i]) pendingDocs.push(`${d} — for ${t.title}${t.period ? ' ' + t.period : ''}`); });
    return `
    <div class="row-between wrap"><h2>Work & tasks</h2>${isAdmin() ? `<button class="primary" data-act="newTask" data-cid="${S.cid}">+ New task</button>` : ''}</div>
    ${pendingDocs.length ? `<div class="warn"><b>Documents ${isAdmin() ? 'pending from client' : 'we need from you'}:</b><ul>${pendingDocs.map(d => `<li>${esc(d)}</li>`).join('')}</ul></div>` : ''}
    <table class="tbl"><thead><tr><th>No.</th><th>Work</th><th>Period</th><th>Due</th><th>Status</th><th>Progress</th>${isAdmin() ? '<th>Assignee</th>' : ''}</tr></thead><tbody>
    ${list.map(t => `<tr class="click" data-act="openTask" data-id="${t.id}"><td class="mono">${tno(t)}</td><td>${esc(t.title)}</td><td>${esc(t.period)}</td>
      <td class="nowrap ${overdue(t) ? 'red' : ''}">${isoToDisp(t.due)}</td><td>${statusTag(t.status)}</td><td>${progress(t)}%</td>${isAdmin() ? `<td>${esc(t.assignee || '—')}</td>` : ''}</tr>`).join('')
      || `<tr><td colspan="7" class="muted empty">No tasks yet.</td></tr>`}</tbody></table>`;
  };
  T.dashCard = () => {
    const open = S.tasks.filter(t => !['Completed', 'Cancelled'].includes(t.status));
    const by = {}; for (const t of open) by[t.assignee || 'Unassigned'] = (by[t.assignee || 'Unassigned'] || 0) + 1;
    return `<section class="card"><div class="row-between"><h2>Tasks</h2><button class="sm" data-act="go" data-v="tasks">Open task board →</button></div>
      <div class="pills">${BOARD.filter(s => s !== 'Completed').map(s => `<span class="pillstat">${s}: <b>${open.filter(t => t.status === s).length}</b></span>`).join('')}
        <span class="pillstat red">Overdue: <b>${open.filter(overdue).length}</b></span></div>
      <div class="pills">${Object.entries(by).map(([k, n]) => `<span class="pillstat">${esc(k)}: <b>${n}</b></span>`).join('') || '<span class="muted small">No open tasks.</span>'}</div></section>`;
  };

  /* ---------- workflow masters ---------- */
  T.vWorkflow = () => `
    <button class="link back" data-act="go" data-v="tasks">← Tasks</button>
    <section class="card"><h2>Staff</h2><p class="muted small">Names used for task assignment and timesheets.</p>
      <div class="pills">${(S.wf.staff || []).map((s, i) => `<span class="pillstat">${esc(s)} <button class="icon" data-act="delStaff" data-i="${i}">✕</button></span>`).join('') || '<span class="muted small">No staff added.</span>'}</div>
      <form data-form="addStaff" class="row"><input name="name" placeholder="Staff name" required style="max-width:260px"><button class="primary">Add staff</button></form></section>
    <section class="card"><div class="row-between wrap"><h2>Departments & work categories</h2>
      <div class="btns"><button data-act="addDept">+ Department</button><button data-act="resetWf">Restore defaults</button></div></div>
      <p class="muted small">Each work category has a checklist: documents required from the client, activities with % weight (drives task progress) and outcome documents.</p>
      ${S.wf.departments.map((d, di) => `<div class="dept">
        <div class="row-between wrap"><h3>${esc(d.name)}</h3><div class="btns">
          <label class="small">Default assignee <select data-change="deptAssignee" data-di="${di}" style="width:auto">${staffOpts(d.assignee)}</select></label>
          <button class="sm" data-act="addCat" data-di="${di}">+ Work category</button><button class="sm danger" data-act="delDept" data-di="${di}">Delete</button></div></div>
        <div class="cats">${d.categories.map((c, ci) => `<button class="catbtn" data-act="editCat" data-di="${di}" data-ci="${ci}">${esc(c.name)}
          <span class="muted tiny">${c.docs.length} docs · ${c.acts.length} activities · ${c.outs.length} outcomes</span></button>`).join('')}</div></div>`).join('')}
    </section>`;

  /* ---------- actions ---------- */
  Object.assign(A, {
    taskMode: ({ m }) => { S.tf.mode = m; render(); },
    openTask: ({ id }) => { S.task = id; S.view = 'task'; render(); window.scrollTo(0, 0); },
    newTask: ({ cid }) => {
      modal(`<h2>New task</h2><form data-form="newTask" class="grid">
        <label class="span2">Client<select name="clientId" required><option value=""></option>${S.clients.map(c => `<option value="${c.id}" ${c.id === (cid || '') ? 'selected' : ''}>${esc(c.name)}${c.gstin ? ' · ' + c.gstin : ''}</option>`).join('')}</select></label>
        <label class="span2">Work category<select name="catId" required>${S.wf.departments.map(d => `<optgroup label="${esc(d.name)}">${d.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>
        <label>Period<input name="period" placeholder="e.g. Oct 2026 / FY 2025-26"></label>
        <label>Due date<input type="date" name="due"></label>
        <label>Assign to<select name="assignee"><option value="__dept">Department default</option>${staffOpts('', 'Unassigned')}</select></label>
        <label>Priority<select name="priority">${PRIORITIES.map(p => `<option ${p === 'Normal' ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
        <label>Fee (₹)<input type="number" name="fee" min="0"></label>
        <label>Title (optional)<input name="title" placeholder="Defaults to the work category"></label>
        <div class="span2 btns"><button class="primary">Create task</button><button type="button" data-act="closeModal">Cancel</button></div></form>`);
    },
    genTasks: () => {
      const t = new Date(), y = t.getFullYear(), m = t.getMonth();
      const from = new Date(y, m, 1).toISOString().slice(0, 10), to = new Date(y, m + 2, 0).toISOString().slice(0, 10);
      modal(`<h2>Generate tasks from compliance calendar</h2>
        <p class="muted small">Creates one task per client per return due in the range, with the checklist from its work category. Returns already marked filed, and ones that already have a task, are skipped.</p>
        <form data-form="genPreview" class="grid">
          <label>Due from<input type="date" name="from" value="${from}"></label><label>Due to<input type="date" name="to" value="${to}"></label>
          <label class="span2">Assign to<select name="assignee"><option value="__dept">Department default</option>${staffOpts('', 'Unassigned')}</select></label>
          <div class="span2"><button class="primary">Preview</button></div></form><div id="genOut"></div>`);
    },
    genCreate: () => guard(async () => {
      const g = S.genPending; let n = 0;
      for (const it of g.items.filter((_, i) => document.querySelector(`#gen_${i}`)?.checked)) {
        await createTask({ clientId: it.c.id, catId: catForKey(it.key), title: it.form, period: it.period, due: isoLocal(it.due),
          filingKey: it.key, assignee: g.assignee === '__dept' ? undefined : g.assignee });
        n++;
      }
      S.genPending = null; closeModal(); S.view = 'tasks'; render(); toast(`${n} task(s) created`);
    }),
    starTask: () => guard(async () => { const t = S.tasks.find(x => x.id === S.task); await patch(t.id, { starred: !t.starred }); render(); }),
    fwdTask: () => {
      const t = S.tasks.find(x => x.id === S.task);
      modal(`<h2>Forward / reassign ${tno(t)}</h2><form data-form="fwdTask" class="grid narrow">
        <label>Assign to<select name="assignee">${staffOpts(t.assignee)}</select></label>
        <label class="span2">Note for the new assignee<input name="note"></label>
        <div class="span2 btns"><button class="primary">Forward</button><button type="button" data-act="closeModal">Cancel</button></div></form>`);
    },
    delTask: () => {
      if (!confirm('Delete this task?')) return;
      guard(async () => { await deleteDoc(doc(db, 'tasks', S.task)); S.tasks = S.tasks.filter(t => t.id !== S.task); S.view = 'tasks'; render(); }, 'Task deleted');
    },
    delStaff: ({ i }) => guard(async () => { S.wf.staff.splice(+i, 1); await saveWf(); render(); }),
    addDept: () => { const n = prompt('Department name'); if (n) guard(async () => { S.wf.departments.push({ id: 'd' + Date.now().toString(36), name: n.trim(), assignee: '', categories: [] }); await saveWf(); render(); }); },
    delDept: ({ di }) => { if (confirm('Delete this department and its work categories? Existing tasks are kept.')) guard(async () => { S.wf.departments.splice(+di, 1); await saveWf(); render(); }); },
    resetWf: () => { if (confirm('Replace departments and work categories with the defaults? Staff list is kept.')) guard(async () => { S.wf = { ...structuredClone(DEFAULT_WORKFLOW), staff: S.wf.staff }; await saveWf(); render(); }, 'Defaults restored'); },
    addCat: ({ di }) => A.editCat({ di, ci: '' }),
    editCat: ({ di, ci }) => {
      const c = ci === '' ? { name: '', docs: [], acts: [], outs: [] } : S.wf.departments[+di].categories[+ci];
      modal(`<h2>${ci === '' ? 'New' : 'Edit'} work category — ${esc(S.wf.departments[+di].name)}</h2>
        <form data-form="saveCat" data-di="${di}" data-ci="${ci}" class="grid">
          <label class="span2">Name<input name="name" value="${esc(c.name)}" required></label>
          <label>Documents required (one per line)<textarea name="docs" rows="7">${esc(c.docs.join('\n'))}</textarea></label>
          <label>Outcome documents (one per line)<textarea name="outs" rows="7">${esc(c.outs.join('\n'))}</textarea></label>
          <label class="span2">Activities — one per line as <code>Activity | weight%</code><textarea name="acts" rows="7">${esc(c.acts.map(a => `${a.name} | ${a.weight}`).join('\n'))}</textarea></label>
          <div class="span2 btns"><button class="primary">Save</button>${ci !== '' ? '<button type="button" class="danger" data-act="delCat">Delete category</button>' : ''}<button type="button" data-act="closeModal">Cancel</button></div>
        </form>`);
      S.catEdit = { di: +di, ci: ci === '' ? null : +ci };
    },
    delCat: () => { if (confirm('Delete this work category?')) guard(async () => { S.wf.departments[S.catEdit.di].categories.splice(S.catEdit.ci, 1); await saveWf(); closeModal(); render(); }); },
  });
  const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  /* ---------- forms ---------- */
  Object.assign(F, {
    newTask: fd => guard(async () => {
      const a = fd.get('assignee');
      const id = await createTask({ clientId: fd.get('clientId'), catId: fd.get('catId'), period: fd.get('period').trim(), due: fd.get('due'),
        priority: fd.get('priority'), fee: fd.get('fee'), title: fd.get('title').trim() || undefined, assignee: a === '__dept' ? undefined : a });
      closeModal(); S.task = id; S.view = 'task'; render();
    }, 'Task created'),
    genPreview: fd => {
      const from = new Date(fd.get('from') + 'T00:00'), to = new Date(fd.get('to') + 'T23:59');
      const have = new Set(S.tasks.map(t => `${t.clientId}|${t.filingKey}`));
      const items = [];
      for (const c of S.clients) for (const it of dueItems(c, from, to)) {
        if (it.note === 'Optional') continue;
        if (S.allFilings[`${c.id}|${it.key}`]?.status === 'filed' || have.has(`${c.id}|${it.key}`)) continue;
        items.push({ ...it, c });
      }
      S.genPending = { items, assignee: fd.get('assignee') };
      $('#genOut').innerHTML = items.length ? `<hr><div class="row-between"><b>${items.length} task(s) to create</b>
        <label class="chk"><input type="checkbox" checked data-change="genAll"> Select all</label></div>
        <div class="genlist">${items.map((it, i) => `<label class="chk"><input type="checkbox" id="gen_${i}" checked> ${fmtDate(it.due)} — <b>${esc(it.c.name)}</b> — ${esc(it.form)} (${esc(it.period)})</label>`).join('')}</div>
        <div class="btns"><button class="primary" data-act="genCreate">Create tasks</button></div>`
        : '<p class="muted">Nothing to create in this range — every due item is already filed or has a task.</p>';
    },
    taskEdit: fd => guard(async () => {
      const t = S.tasks.find(x => x.id === S.task);
      const upd = { status: fd.get('status'), assignee: fd.get('assignee'), due: fd.get('due'), priority: fd.get('priority'), title: fd.get('title').trim(),
        period: fd.get('period').trim(), ack: fd.get('ack').trim(), fee: +fd.get('fee') || 0, received: +fd.get('received') || 0, billed: !!fd.get('billed') };
      const changes = [];
      if (upd.status !== t.status) changes.push(`Status: ${t.status} → ${upd.status}`);
      if (upd.assignee !== t.assignee) changes.push(`Assigned: ${t.assignee || 'Unassigned'} → ${upd.assignee || 'Unassigned'}`);
      if (upd.due !== t.due) changes.push(`Due date: ${isoToDisp(t.due) || '—'} → ${isoToDisp(upd.due) || '—'}`);
      if (upd.received !== (t.received || 0)) changes.push(`Received: ₹${t.received || 0} → ₹${upd.received}`);
      if (upd.billed && !t.billed) changes.push('Bill raised');
      if (upd.status === 'Completed' && t.status !== 'Completed') upd.done = { ...t.done, acts: (t.list?.acts || []).map(() => true) };
      await patch(t.id, upd, changes.join('; ') || 'Details updated');
      if (upd.status === 'Completed' && t.filingKey) await syncFiling(t, upd.ack);
      render();
    }, 'Saved'),
    taskNote: (fd, form) => guard(async () => {
      const t = S.tasks.find(x => x.id === S.task);
      await patch(t.id, { notes: [...(t.notes || []), { at: nowISO(), by: me(), text: fd.get('text').trim() }] }); render();
    }),
    taskTime: fd => guard(async () => {
      const t = S.tasks.find(x => x.id === S.task);
      const e = { date: fd.get('date'), by: fd.get('by') || me(), mins: Math.round(+fd.get('hrs') * 60), note: fd.get('note').trim() };
      const upd = { time: [...(t.time || []), e] };
      if (t.status === 'Not started') upd.status = 'In progress';
      await patch(t.id, upd, `${(e.mins / 60).toFixed(2)} h logged by ${e.by}`); render();
    }, 'Time logged'),
    fwdTask: fd => guard(async () => {
      const t = S.tasks.find(x => x.id === S.task), to = fd.get('assignee'), note = fd.get('note').trim();
      await patch(t.id, { assignee: to }, `Forwarded: ${t.assignee || 'Unassigned'} → ${to || 'Unassigned'}${note ? ` — ${note}` : ''}`);
      closeModal(); render();
    }, 'Task forwarded'),
    addStaff: fd => guard(async () => { const n = fd.get('name').trim(); if (!S.wf.staff.includes(n)) S.wf.staff.push(n); await saveWf(); render(); }),
    saveCat: (fd, form) => guard(async () => {
      const lines = k => (fd.get(k) || '').split('\n').map(s => s.trim()).filter(Boolean);
      const acts = lines('acts').map(l => { const [n, w] = l.split('|'); return { name: n.trim(), weight: Math.max(0, parseFloat(w) || 0) }; });
      const total = acts.reduce((s, a) => s + a.weight, 0);
      if (acts.length && total === 0) acts.forEach(a => a.weight = Math.round(100 / acts.length));
      const { di, ci } = S.catEdit; const d = S.wf.departments[di];
      const c = { id: ci === null ? (fd.get('name').replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase() + Date.now().toString(36).slice(-3)) : d.categories[ci].id,
        name: fd.get('name').trim(), docs: lines('docs'), acts, outs: lines('outs') };
      if (ci === null) d.categories.push(c); else d.categories[ci] = c;
      await saveWf(); closeModal(); render();
    }, 'Work category saved'),
  });

  /* ---------- change handlers ---------- */
  Object.assign(C, {
    tf: el => { S.tf[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; render(); },
    tcheck: el => guard(async () => {
      const t = S.tasks.find(x => x.id === S.task), sec = el.dataset.sec, i = +el.dataset.i;
      const arr = [...(t.done?.[sec] || [])]; arr[i] = el.checked;
      const done = { ...(t.done || {}), [sec]: arr };
      const item = t.list[sec][i]; const name = typeof item === 'string' ? item : item.name;
      const upd = { done };
      if (t.status === 'Not started' && el.checked) upd.status = 'In progress';
      await patch(t.id, upd, `${el.checked ? '✓' : '✗'} ${name}`); render();
    }),
    deptAssignee: el => guard(async () => { S.wf.departments[+el.dataset.di].assignee = el.value; await saveWf(); }),
    genAll: el => document.querySelectorAll('[id^=gen_]').forEach(c => c.checked = el.checked),
  });

  /* ---------- search & drag-and-drop ---------- */
  document.addEventListener('input', e => {
    if (e.target.id === 'tq') { S.tf.q = e.target.value; const pos = e.target.selectionStart; render(); const s = $('#tq'); s.focus(); s.setSelectionRange(pos, pos); }
  });
  let dragId = null;
  document.addEventListener('dragstart', e => { const c = e.target.closest?.('[data-tid]'); if (c) { dragId = c.dataset.tid; e.dataTransfer.effectAllowed = 'move'; } });
  document.addEventListener('dragover', e => { const col = e.target.closest?.('.col'); if (col && dragId) { e.preventDefault(); col.classList.add('over'); } });
  document.addEventListener('dragleave', e => { const col = e.target.closest?.('.col'); if (col) col.classList.remove('over'); });
  document.addEventListener('drop', e => {
    const col = e.target.closest?.('.col'); if (!col || !dragId) return; e.preventDefault();
    const t = S.tasks.find(x => x.id === dragId), to = col.dataset.status; dragId = null;
    if (!t || t.status === to || !isAdmin()) return render();
    guard(async () => {
      const upd = { status: to };
      if (to === 'Completed') upd.done = { ...t.done, acts: (t.list?.acts || []).map(() => true) };
      await patch(t.id, upd, `Status: ${t.status} → ${to}`);
      if (to === 'Completed') await syncFiling(t);
      render();
    });
  });

  return T;
}
