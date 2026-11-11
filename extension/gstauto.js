// GSTR-1 / IFF autopilot on the GST portal, started from CA Desk ("Upload JSON to GST portal").
// You type the CAPTCHA and sign in; then it: Returns Dashboard → year / quarter / month → Search →
// GSTR-1 (or IFF) → Prepare offline → uploads the JSON → waits for "Processed" → Prepare online → Generate summary.
// It never files the return, never signs with DSC/EVC and never touches CAPTCHA/OTP.
(() => {
  if (window.top !== window) return;
  const DASH = 'https://return.gst.gov.in/returns/auth/dashboard';
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = m => new Promise(r => { try { chrome.runtime.sendMessage(m, x => r(x)); } catch { r(null); } });
  const visible = el => !!el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
  const textOf = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  let job, stopped = false;

  /* ---------- banner ---------- */
  function banner(msg, kind = 'run') {
    let b = document.getElementById('capm-auto');
    if (!b) {
      b = document.createElement('div'); b.id = 'capm-auto';
      b.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:2147483647;font:14px/1.45 system-ui,Segoe UI,sans-serif;padding:12px 16px;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.3);max-width:620px;display:flex;gap:14px;align-items:center;color:#fff';
      document.body.appendChild(b);
    }
    b.style.background = kind === 'err' ? '#9B1C1C' : kind === 'done' ? '#0B7A5C' : '#15233F';
    b.innerHTML = '';
    const t = document.createElement('div'); t.innerHTML = `<b>CA Desk autopilot</b> · ${job ? `${job.ret} ${job.periodLabel} · ${job.gstin}` : ''}<br>${msg}`; b.appendChild(t);
    const x = document.createElement('button'); x.textContent = kind === 'run' ? 'Stop' : 'Close';
    x.style.cssText = 'background:#fff;color:#15233F;border:0;border-radius:6px;padding:6px 12px;font-weight:600;cursor:pointer;white-space:nowrap';
    x.onclick = async () => { stopped = true; if (kind === 'run') await send({ type: 'CAPM_JOB_CLEAR' }); b.remove(); };
    b.appendChild(x);
  }
  const fail = async msg => { banner(msg, 'err'); await send({ type: 'CAPM_JOB_CLEAR' }); stopped = true; };
  const setStage = async (stage, extra = {}) => { job = { ...job, ...extra, stage }; await send({ type: 'CAPM_JOB_SET', job: { ...extra, stage } }); };

  /* ---------- finding things by what they say ---------- */
  async function waitFor(fn, ms = 30000, step = 400) {
    const end = Date.now() + ms;
    while (Date.now() < end && !stopped) { const r = fn(); if (r) return r; await sleep(step); }
    return null;
  }
  const clickables = () => [...document.querySelectorAll('button, a, input[type=button], input[type=submit], [role=button]')].filter(visible);
  const byText = (re, root = document) => [...root.querySelectorAll('button, a, input[type=button], input[type=submit], [role=button]')].filter(visible).find(e => re.test(textOf(e) || e.value || ''));
  function click(el) { el.scrollIntoView({ block: 'center' }); el.click(); }
  function chooseOption(sel, re) {
    const o = [...sel.options].find(o => re.test(o.text.trim()));
    if (!o) return false;
    if (sel.value === o.value) return true;
    sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); sel.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  const selects = () => [...document.querySelectorAll('select')].filter(visible);
  const selWith = re => selects().find(s => [...s.options].some(o => re.test(o.text.trim())));
  // the tile of this return on the dashboard: smallest block that names the return and has the button
  function tileButton(btnRe) {
    const retRe = job.ret === 'IFF' ? /\bIFF\b|Invoice Furnishing/i : /\bGSTR-?1\b|Details of outward supplies/i;
    for (const b of clickables().filter(e => btnRe.test(textOf(e) || e.value || ''))) {
      let p = b.parentElement;
      for (let i = 0; p && i < 8; i++, p = p.parentElement) {
        const t = textOf(p);
        if (clickables().filter(e => p.contains(e) && btnRe.test(textOf(e) || e.value || '')).length > 1) break; // reached the row of tiles
        if (retRe.test(t.replace(/GSTR-?1A\b/gi, ''))) return b;
      }
    }
    return null;
  }

  /* ---------- steps ---------- */
  async function onDashboard() {
    banner('Selecting the return period…');
    const fySel = await waitFor(() => selWith(/^\d{4}\s*-\s*\d{2,4}$/));
    if (!fySel) return fail('Could not find the Financial Year box on the Returns Dashboard. Select the period yourself and click Prepare offline — the autopilot will continue from the upload page.');
    chooseOption(fySel, new RegExp('^' + job.fy.replace('-', '\\s*-\\s*(20)?') + '$'));
    await sleep(900);
    const qSel = await waitFor(() => selWith(/quarter/i), 8000);
    if (qSel) { chooseOption(qSel, new RegExp(`Quarter\\s*${job.quarter}\\b`, 'i')); await sleep(900); }
    const mSel = await waitFor(() => selWith(new RegExp(`^${MONTHS[job.month - 1]}$`, 'i')), 8000);
    if (mSel) { chooseOption(mSel, new RegExp(`^${MONTHS[job.month - 1]}$`, 'i')); await sleep(700); }
    const search = await waitFor(() => byText(/^\s*search\s*$/i), 8000);
    if (search) click(search);
    const btnRe = job.stage === 'pdf' ? /download|^\s*view\s*$/i : job.stage === 'online' ? /prepare\s*online/i : /prepare\s*offline/i;
    banner(`Opening ${job.ret} → ${job.stage === 'online' ? 'Prepare online' : 'Prepare offline'}…`);
    const b = await waitFor(() => tileButton(btnRe), 30000);
    if (!b) return fail(`Could not find ${job.ret} → ${job.stage === 'online' ? 'Prepare online' : 'Prepare offline'} on the dashboard. Click it yourself — the autopilot continues on the next page.`);
    click(b);
  }

  async function onOffline() {
    if (job.stage === 'uploaded') return watchStatus();
    banner('Uploading the JSON…');
    const up = byText(/^\s*upload\s*$/i); if (up && !document.querySelector('input[type=file]')) { click(up); await sleep(800); } // Upload tab
    const input = await waitFor(() => document.querySelector('input[type=file]'), 20000);
    if (!input) return fail('Could not find “Choose file” on the upload page. Upload the JSON yourself (CA Desk → Download JSON again).');
    const file = new File([job.json], job.jsonName, { type: 'application/json' });
    const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(2500);
    const go = clickables().find(e => /^\s*upload\s*$/i.test(textOf(e) || e.value || '') && !e.disabled && e.tagName !== 'A');
    if (go) click(go);
    await setStage('uploaded', { uploadedAt: Date.now() });
    banner('JSON uploaded. Waiting for the portal to process it (usually 1–5 minutes)…');
    await sleep(8000);
    return watchStatus();
  }

  // Latest row of "Upload History": read the Status column (not the "Error Report" header)
  function latestUpload() {
    for (const tbl of [...document.querySelectorAll('table')].filter(visible)) {
      const rows = [...tbl.querySelectorAll('tr')];
      const head = rows.find(r => r.querySelector('th')) || rows[0]; if (!head) continue;
      const hc = [...head.children].map(textOf);
      const si = hc.findIndex(h => /^status$/i.test(h)); if (si < 0) continue;
      const di = hc.findIndex(h => /^date$/i.test(h)), ti = hc.findIndex(h => /^time$/i.test(h)), ei = hc.findIndex(h => /error/i.test(h));
      const data = rows.filter(r => r !== head && r.querySelectorAll('td').length > si);
      if (!data.length) return { status: '' };
      const c = [...data[0].querySelectorAll('td')].map(textOf);
      const [dd, mm, yy] = (c[di] || '').split('/').map(Number), [h, mi, se] = (c[ti] || '').split(':').map(Number);
      const when = yy ? new Date(yy, mm - 1, dd, h || 0, mi || 0, se || 0).getTime() : 0;
      return { status: c[si] || '', when, err: ei >= 0 ? c[ei] : '' };
    }
    return null;
  }

  async function watchStatus() {
    const deadline = (job.uploadedAt || Date.now()) + 20 * 60000;
    while (!stopped && Date.now() < deadline) {
      const u = await waitFor(() => latestUpload(), 10000);
      const fresh = u && (!u.when || !job.uploadedAt || u.when >= job.uploadedAt - 15 * 60000); // allow for the PC clock being off
      const st = fresh ? u.status : '';
      if (/error/i.test(st)) return fail('The portal processed the file WITH ERRORS. Click “Generate error report”, then “Download error report”, fix the invoices in Tally and fetch again.');
      if (/^processed$/i.test(st) || (/processed/i.test(st) && !/error/i.test(st))) {
        await setStage('online');
        banner('Processed — no errors. Opening Prepare online → Generate summary…');
        await sleep(1200);
        const back = byText(/back\s*to\s*file\s*returns/i);
        if (back) click(back); else location.href = DASH;
        return;
      }
      banner(`Waiting for the portal to process the JSON… status: ${st || 'not shown yet'}`);
      await sleep(15000);
      if (stopped) return;
      const refresh = [...document.querySelectorAll('[class*=refresh], .fa-refresh, [title*=efresh]')].find(visible);
      if (refresh) { click(refresh); await sleep(3000); continue; }
      location.reload(); return;
    }
    if (!stopped) fail('The portal is taking longer than 20 minutes to process the file. Check “Upload history” later, then use Prepare online → Generate summary.');
  }

  async function onOnline() {
    if (job.stage !== 'online') return;
    banner('Generating summary…');
    const g = await waitFor(() => byText(/generate\s*summary/i), 30000);
    if (!g) return fail('Could not find Generate summary. Click it yourself on this page.');
    click(g);
    await sleep(3000);
    const ok = byText(/^\s*(ok|yes|proceed)\s*$/i); if (ok) click(ok);
    await setStage('filing');
    banner(`Summary generation requested. In a minute, refresh this page, check the summary against CA Desk, then file with DSC or EVC yourself. When the return is filed, the ARN and GSTR-1 PDF are saved to CA Desk automatically.`, 'done');
  }

  /* ---------- after you file: ARN + PDF back to CA Desk ---------- */
  function filedArn() {
    const t = textOf(document.body);
    if (!t.includes(job.gstin)) return null;
    const m = t.match(/successfully\s+filed[^]*?Acknowledge?ment\s+Reference\s+Number\s+is\s*(AA[0-9A-Z]{13})/i) || t.match(/\bARN\b[^A-Z0-9]{0,30}(AA[0-9A-Z]{13})/);
    return m ? m[1].toUpperCase() : null;
  }
  async function checkFiled() {
    if (!job || !['filing', 'online'].includes(job.stage) || job.arn) return;
    const arn = filedArn(); if (!arn) return;
    const d = new Date(), filedOn = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await setStage('pdf', { arn, filedOn });
    await send({ type: 'CAPM_G1_ARN', arn, filedOn });
    banner(`Filed — ARN ${arn} saved to CA Desk. Downloading the filed ${job.ret} PDF…`);
    await sleep(1500);
    const dl = byText(/download.*(pdf|filed)|filed.*download/i);
    if (dl) { click(dl); return waitPdf(); }
    location.href = DASH; // dashboard → the return's tile → View / Download
  }
  async function waitPdf() {
    banner(`ARN ${job.arn} saved to CA Desk. Waiting for the PDF download…`);
    const ok = await waitFor(() => job.pdfDone, 60000, 1000);
    if (ok) { await send({ type: 'CAPM_JOB_CLEAR' }); banner(`Done — ARN ${job.arn} and the ${job.ret} PDF are saved in CA Desk.`, 'done'); }
    else banner(`ARN ${job.arn} is saved in CA Desk. The PDF did not download — click “Download (PDF)” on the ${job.ret} page and it will be saved to CA Desk too.`, 'done');
  }
  async function onPdfPage() {
    const dl = await waitFor(() => byText(/download\s*\(?\s*pdf|download\s*filed|^\s*download\s*$/i), 20000);
    if (!dl) return banner(`ARN ${job.arn} is saved in CA Desk. Click the PDF download on this page and it will be saved to CA Desk too.`, 'done');
    click(dl); return waitPdf();
  }
  // PDFs the portal builds in the page (blob downloads) are passed here by hook.js
  window.addEventListener('message', async e => {
    if (e.source !== window || e.data?.type !== 'CAPM_PDF' || !job || !['pdf', 'filing'].includes(job.stage)) return;
    await send({ type: 'CAPM_G1_PDF', b64: e.data.b64, name: e.data.name || '' });
    job.pdfDone = true;
  });

  /* ---------- router ---------- */
  async function route() {
    job = await send({ type: 'CAPM_JOB_GET' });
    if (!job || stopped) return;
    const u = location.href;
    if (['filing', 'online'].includes(job.stage) && filedArn()) return checkFiled();
    if (job.stage === 'filing') return; // waiting for you to file with DSC/EVC
    if (job.stage === 'pdf' && !/dashboard/.test(u)) return onPdfPage();
    if (/services\.gst\.gov\.in\/services\/login/.test(u)) { banner('Type the CAPTCHA and click Login. The autopilot takes over after you sign in.'); return; }
    if (/services\.gst\.gov\.in\/services\/auth\//.test(u)) { banner('Signed in. Opening the Returns Dashboard…'); await sleep(1500); location.href = DASH; return; }
    if (/return\.gst\.gov\.in\/returns\/auth\/dashboard/.test(u)) return onDashboard();
    if (/offline|upload/i.test(u)) return onOffline();
    if (/return\.gst\.gov\.in\/returns\/auth\/(gstr1|iff|gstr-?1)/i.test(u) || byText(/generate\s*summary/i)) return onOnline();
    // single-page app: watch for route changes
  }
  setInterval(async () => { if (stopped) return; const j = await send({ type: 'CAPM_JOB_GET' }); if (j && ['filing', 'online'].includes(j.stage) && !j.arn) { job = j; checkFiled(); } }, 3000);
  let last = '';
  setInterval(() => { if (location.href !== last && !stopped) { last = location.href; route(); } }, 1200);
})();
