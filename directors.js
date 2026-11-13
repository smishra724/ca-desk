// Directors / designated partners as a proper register (name, DIN, designation, appointed, ceased)
// and import from the MCA "Company / LLP Master Data" page — one client from the client page,
// or many clients at once from the Excel import page (matched by CIN, then name).
import { parseMasterData, masterDataFromHtml, extractText } from './extract.js';

export const COMPANYISH = ['Private Ltd', 'Public Ltd', 'OPC', 'LLP'];
const MCA_FIELDS = [['name', 'Legal name'], ['cin', 'CIN / LLPIN'], ['doi', 'Date of incorporation'], ['email', 'Email'], ['address', 'Registered address'], ['state', 'State'], ['pincode', 'PIN code'], ['constitution', 'Constitution']];
const MCA_INFO = [['roc', 'ROC'], ['mcaStatus', 'Status'], ['authCap', 'Authorised capital'], ['paidCap', 'Paid-up capital'], ['lastAgm', 'Last AGM'], ['lastBs', 'Last balance sheet']];

export function initDirectors(ctx) {
  const { S, A, C, F, esc, toast, modal, closeModal, guard, render, isoToDisp, isAdmin, db, fs, saveFile, openClient, loadClients, busy } = ctx;
  const { doc, updateDoc, serverTimestamp } = fs;
  const D = {};
  const norm = s => String(s || '').toUpperCase().replace(/\b(PRIVATE|PVT|LIMITED|LTD|LLP|THE)\b/g, '').replace(/[^A-Z0-9]/g, '');
  const inr = v => v ? '₹' + Number(v).toLocaleString('en-IN') : '';
  const peopleText = list => list.filter(d => !d.ceased).map(d => `${d.name}${d.din ? ` (DIN ${d.din})` : d.pan ? ` (PAN ${d.pan})` : ''}${d.designation ? ` — ${d.designation}` : ''}`).join('\n');
  const label = c => c?.constitution === 'LLP' ? 'Designated partners' : 'Directors';

  // merge directors read from MCA into the saved list (match by DIN, then PAN, then name)
  function merge(saved = [], read = []) {
    const out = saved.map(d => ({ ...d })), changes = [];
    for (const r of read) {
      const ex = out.find(d => (r.din && d.din === r.din) || (r.pan && d.pan === r.pan) || (!r.din && !r.pan && norm(d.name) === norm(r.name)));
      if (!ex) { out.push({ ...r }); changes.push(['New', r]); continue; }
      const diff = ['name', 'designation', 'appointed', 'ceased', 'din', 'pan'].filter(k => r[k] && r[k] !== ex[k]);
      if (diff.length) { Object.assign(ex, Object.fromEntries(diff.map(k => [k, r[k]]))); changes.push(['Updated: ' + diff.join(', '), r]); } else changes.push(['Same', r]);
    }
    return { list: out, changes };
  }

  /* ---------- the card on the client's master data tab ---------- */
  D.section = () => {
    const c = S.client || {}; if (!S.cid || !COMPANYISH.includes(c.constitution)) return '';
    const list = c.directors || [], adm = isAdmin(), showOld = S.dirOld;
    const rows = list.map((d, i) => ({ d, i })).filter(({ d }) => showOld || !d.ceased);
    const info = MCA_INFO.filter(([k]) => c.mca?.[k]).map(([k, l]) => `<span><span class="muted">${l}</span> <b>${/Cap$/.test(k) ? inr(c.mca[k]) : /^last/.test(k) ? isoToDisp(c.mca[k]) : esc(c.mca[k])}</b></span>`).join('');
    return `<section class="card dirs">
      <div class="row-between wrap"><h2>${label(c)} <span class="muted small">${list.filter(d => !d.ceased).length} current${list.some(d => d.ceased) ? ` · ${list.filter(d => d.ceased).length} former` : ''}</span></h2>
        ${adm ? `<div class="btns"><button data-act="mcaImport">Import MCA master data</button><button class="primary" data-act="dirEdit">+ Add</button></div>` : ''}</div>
      ${info ? `<div class="mcainfo">${info}${c.mca?.at ? `<span class="muted tiny">from MCA master data, ${isoToDisp(c.mca.at)}</span>` : ''}</div>` : ''}
      <table class="tbl"><thead><tr><th>Name</th><th>${c.constitution === 'LLP' ? 'DPIN / DIN' : 'DIN'}</th><th>Designation</th><th>Date of appointment</th><th>Date of cessation</th>${adm ? '<th></th>' : ''}</tr></thead><tbody>
      ${rows.map(({ d, i }) => `<tr class="${d.ceased ? 'muted' : ''}"><td><b>${esc(d.name)}</b>${d.pan ? `<div class="tiny mono muted">PAN ${esc(d.pan)}</div>` : ''}</td><td class="mono">${esc(d.din || '—')}</td><td>${esc(d.designation || '')}</td>
        <td class="nowrap">${isoToDisp(d.appointed) || '—'}</td><td class="nowrap">${d.ceased ? `${isoToDisp(d.ceased)} <span class="tag">Ceased</span>` : '<span class="tag green">Current</span>'}</td>
        ${adm ? `<td class="nowrap"><button class="icon" data-act="dirEdit" data-i="${i}" title="Edit">✎</button><button class="icon" data-act="dirDel" data-i="${i}" title="Delete">✕</button></td>` : ''}</tr>`).join('')
        || `<tr><td colspan="6" class="muted empty">No ${label(c).toLowerCase()} yet.${c.people && adm ? ` <a href="#" data-act="dirFromPeople">Use the names already saved (${esc(c.people.split('\n').filter(Boolean).length)})</a> or` : ''} ${adm ? 'Click <b>Import MCA master data</b> — browse the master data page saved from the MCA site (PDF or web page), or paste it.' : ''}</td></tr>`}</tbody></table>
      ${list.some(d => d.ceased) ? `<label class="chk small"><input type="checkbox" data-change="dirOld" ${showOld ? 'checked' : ''}> Show former ${label(c).toLowerCase()}</label>` : ''}
    </section>`;
  };
  A.dirFromPeople = () => guard(async () => {
    const list = S.client.people.split('\n').map(l => l.trim()).filter(Boolean).map(l => ({ name: l.replace(/\(.*?\)|—.*$|-\s*\d{8}|\b\d{8}\b|DIN[:\s]*/gi, '').replace(/\s+/g, ' ').trim().toUpperCase(), din: (l.match(/\b\d{8}\b/) || [''])[0], pan: '', designation: (l.match(/(managing director|whole[\s-]?time director|additional director|director|designated partner|partner)/i) || [''])[0].replace(/\b\w/g, x => x.toUpperCase()), appointed: '', ceased: '' })).filter(d => d.name);
    await saveDirs(list); render();
  }, 'Directors list created — add appointment dates or import the MCA master data');
  C.dirOld = el => { S.dirOld = el.checked; render(); };
  async function saveDirs(list, extra = {}) {
    await updateDoc(doc(db, 'clients', S.cid), { directors: list, people: peopleText(list), ...extra, updatedAt: serverTimestamp() });
    Object.assign(S.client, { directors: list, people: peopleText(list), ...extra });
  }
  A.dirEdit = ({ i }) => {
    const d = i !== undefined ? S.client.directors[+i] : {};
    modal(`<h2>${i !== undefined ? 'Edit' : 'Add'} ${S.client.constitution === 'LLP' ? 'designated partner' : 'director'}</h2>
      <form data-form="dirSave" class="grid"><input type="hidden" name="i" value="${i ?? ''}">
        <label class="span2">Name<input name="name" value="${esc(d.name || '')}" required></label>
        <label>${S.client.constitution === 'LLP' ? 'DPIN / DIN' : 'DIN'}<input name="din" value="${esc(d.din || '')}" inputmode="numeric" pattern="\\d{8}" title="8 digits"></label>
        <label>PAN (for KMP without DIN)<input name="pan" value="${esc(d.pan || '')}" class="mono"></label>
        <label class="span2">Designation<input name="designation" value="${esc(d.designation || '')}" list="desigList"></label>
        <datalist id="desigList">${['Director', 'Managing Director', 'Whole-time Director', 'Additional Director', 'Independent Director', 'Nominee Director', 'Designated Partner', 'Company Secretary', 'CFO', 'CEO'].map(x => `<option>${x}</option>`).join('')}</datalist>
        <label>Date of appointment<input type="date" name="appointed" value="${esc(d.appointed || '')}"></label>
        <label>Date of cessation / resignation<input type="date" name="ceased" value="${esc(d.ceased || '')}"></label>
        <div class="span2 btns"><button class="primary">Save</button><button type="button" data-act="closeModal">Cancel</button></div></form>`);
  };
  F.dirSave = fd => guard(async () => {
    const list = [...(S.client.directors || [])], i = fd.get('i');
    const d = Object.fromEntries(['name', 'din', 'pan', 'designation', 'appointed', 'ceased'].map(k => [k, String(fd.get(k) || '').trim()]));
    d.name = d.name.toUpperCase(); d.pan = d.pan.toUpperCase();
    if (i === '') list.push(d); else list[+i] = d;
    await saveDirs(list); closeModal(); render();
  }, 'Saved');
  A.dirDel = ({ i }) => { const list = [...(S.client.directors || [])]; if (!confirm(`Delete ${list[+i].name}? (To keep history, edit and add a date of cessation instead.)`)) return; list.splice(+i, 1); guard(async () => { await saveDirs(list); render(); }, 'Deleted'); };

  /* ---------- import from MCA master data (one client) ---------- */
  async function readMca(file, onStep) {
    if (/\.html?$/i.test(file.name) || file.type === 'text/html') return masterDataFromHtml(await file.text());
    if (/\.txt$/i.test(file.name)) return parseMasterData(await file.text());
    return parseMasterData(await extractText(file, onStep));
  }
  A.mcaImport = () => {
    S.mca = null;
    modal(`<h2>Import MCA master data</h2>
      <p class="small">On the MCA site open <b>View Company / LLP Master Data</b> for this CIN, then either:</p>
      <ul class="small"><li><b>Save it</b> — print to PDF (Ctrl + P → Save as PDF) or save the web page (Ctrl + S), and browse it here, or take a screenshot; or</li>
        <li><b>Copy it</b> — select the whole page (Ctrl + A, Ctrl + C) and paste it in the box.</li></ul>
      <label class="filebtn">Browse master data file<input type="file" accept=".pdf,.html,.htm,.txt,image/*" data-change="mcaFile"></label>
      <textarea id="mcaPaste" rows="5" placeholder="…or paste the master data page here"></textarea>
      <div class="btns mt"><button data-act="mcaPasteGo">Read pasted text</button></div>
      <div id="mcaStatus" class="muted small"></div><div id="mcaReview"></div>`);
  };
  const show = (res, file) => { S.mca = { res, file }; document.getElementById('mcaReview').innerHTML = review(res); document.getElementById('mcaStatus').textContent = `${Object.keys(res.fields).length} detail(s) and ${res.directors.length} ${label(S.client).toLowerCase()} read.`; };
  D.show = (res, file) => show(res, file);
  C.mcaFile = el => { const f = el.files[0]; el.value = ''; if (!f) return; guard(async () => { busy(true, 'Reading master data…'); const res = await readMca(f, m => busy(true, m)); busy(false); show(res, f); }); };
  A.mcaPasteGo = () => { const t = document.getElementById('mcaPaste').value; if (!t.trim()) return toast('Paste the master data page first.'); show(parseMasterData(t), null); };
  function review(res) {
    const c = S.client, keys = MCA_FIELDS.filter(([k]) => res.fields[k]);
    if (!keys.length && !res.directors.length) return '<p class="warn">Nothing could be read. Use a PDF printed from the MCA page (not a scan), the saved web page, or paste the page text.</p>';
    if (res.fields.cin && c.cin && res.fields.cin !== c.cin) return `<p class="warn">This master data is for CIN <b>${esc(res.fields.cin)}</b>, but this client's CIN is <b>${esc(c.cin)}</b>. Open the right client or check the file.</p>`;
    const m = merge(c.directors, res.directors);
    return `<form data-form="mcaApply">
      ${keys.length ? `<table class="tbl review"><thead><tr><th></th><th>Field</th><th>From MCA</th><th>Saved now</th></tr></thead><tbody>
        ${keys.map(([k, l]) => { const cur = c[k] || '', diff = cur && String(cur) !== String(res.fields[k]); return `<tr><td><input type="checkbox" name="use_${k}" ${!cur || (diff && ['doi', 'address', 'state', 'pincode', 'email'].includes(k)) ? 'checked' : ''}></td><td>${l}${diff ? ' <span class="tag amber">differs</span>' : ''}</td><td>${esc(k === 'doi' ? isoToDisp(res.fields[k]) : res.fields[k])}</td><td class="muted small">${esc(k === 'doi' ? isoToDisp(cur) : cur)}</td></tr>`; }).join('')}</tbody></table>` : ''}
      ${res.directors.length ? `<h3>${label(c)}</h3><table class="tbl"><thead><tr><th>Name</th><th>DIN / PAN</th><th>Designation</th><th>Appointed</th><th>Ceased</th><th></th></tr></thead><tbody>
        ${m.changes.map(([what, d]) => `<tr><td>${esc(d.name)}</td><td class="mono">${esc(d.din || d.pan)}</td><td>${esc(d.designation)}</td><td>${isoToDisp(d.appointed)}</td><td>${isoToDisp(d.ceased) || '—'}</td><td><span class="tag ${what === 'New' ? 'green' : what === 'Same' ? '' : 'amber'}">${esc(what)}</span></td></tr>`).join('')}</tbody></table>` : ''}
      ${S.mca?.file ? '<label class="chk small"><input type="checkbox" name="saveDoc" checked> Save the master data file to the client’s Documents</label>' : ''}
      <div class="btns mt"><button class="primary">Apply</button><button type="button" data-act="closeModal">Cancel</button></div></form>`;
  }
  F.mcaApply = (fd, form) => guard(async () => {
    const { res, file } = S.mca, c = S.client, upd = {};
    for (const [k] of MCA_FIELDS) if (res.fields[k] && form.elements['use_' + k]?.checked) upd[k] = res.fields[k];
    const mca = { ...(c.mca || {}), ...Object.fromEntries(MCA_INFO.filter(([k]) => res.fields[k]).map(([k]) => [k, res.fields[k]])), at: new Date().toISOString().slice(0, 10) };
    const m = merge(c.directors, res.directors);
    await saveDirs(m.list, { ...upd, mca });
    if (file && form.elements.saveDoc?.checked) await saveFile(S.cid, file, 'ROC Filing', { note: 'MCA master data' });
    closeModal(); await loadClients(); await openClient(S.cid, 'master'); render();
  }, 'MCA master data applied');

  /* ---------- many clients at once (Excel import page) ---------- */
  D.bulkCard = () => `<section class="card">
      <h2>Import MCA master data</h2>
      <p class="small">Browse one or many master data files saved from the MCA site (PDF printed from <b>View Company / LLP Master Data</b>, or the saved web page). Each file is matched to a client by CIN, then by name, and fills date of incorporation, registered address, state, PIN, email, CIN and the directors with DIN, designation, appointment and cessation dates. Blank fields are filled; directors are added or updated.</p>
      <label class="filebtn">Browse master data files<input type="file" multiple accept=".pdf,.html,.htm,.txt" data-change="mcaBulk"></label>
      ${S.mcaBulk ? `<table class="tbl mt"><thead><tr><th>File</th><th>Company</th><th>Client</th><th>Result</th></tr></thead><tbody>${S.mcaBulk.map(r => `<tr><td class="small">${esc(r.file)}</td><td>${esc(r.name || '')}<div class="mono tiny">${esc(r.cin || '')}</div></td><td>${esc(r.client || '—')}</td><td class="small ${r.ok ? '' : 'red'}">${esc(r.msg)}</td></tr>`).join('')}</tbody></table>` : ''}
    </section>`;
  C.mcaBulk = el => {
    const files = [...el.files]; el.value = ''; if (!files.length) return;
    S.mcaBulk = [];
    guard(async () => {
      let n = 0;
      for (const f of files) {
        busy(true, `Reading ${f.name} (${++n} of ${files.length})…`);
        const row = { file: f.name };
        try {
          const res = await readMca(f, () => {});
          Object.assign(row, { name: res.fields.name, cin: res.fields.cin });
          const c = S.clients.find(x => res.fields.cin && x.cin === res.fields.cin) || S.clients.find(x => res.fields.name && norm(x.name) === norm(res.fields.name));
          if (!c) { row.msg = 'No matching client — add the client first (or put its CIN in master data).'; S.mcaBulk.push(row); continue; }
          row.client = c.name;
          const upd = {}; for (const [k] of MCA_FIELDS) if (res.fields[k] && !c[k]) upd[k] = res.fields[k];
          const m = merge(c.directors, res.directors);
          const mca = { ...(c.mca || {}), ...Object.fromEntries(MCA_INFO.filter(([k]) => res.fields[k]).map(([k]) => [k, res.fields[k]])), at: new Date().toISOString().slice(0, 10) };
          await updateDoc(doc(db, 'clients', c.id), { ...upd, mca, directors: m.list, people: peopleText(m.list), updatedAt: serverTimestamp() });
          await saveFile(c.id, f, 'ROC Filing', { note: 'MCA master data' });
          row.ok = true; row.msg = `${Object.keys(upd).length ? 'Filled ' + Object.keys(upd).join(', ') + '. ' : ''}${m.changes.filter(x => x[0] === 'New').length} new, ${m.changes.filter(x => /^Updated/.test(x[0])).length} updated ${label(c).toLowerCase()}.`;
        } catch (e) { row.msg = 'Could not read: ' + e.message; }
        S.mcaBulk.push(row);
      }
      busy(false); await loadClients(); render();
    }, `${files.length} file(s) processed`);
  };
  return D;
}
