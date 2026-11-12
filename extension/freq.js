// GST return filing frequency check on the portal's public "Search Taxpayer" page, started from CA Desk.
// For each GSTIN in the list: fills the GSTIN, you type the CAPTCHA, it searches, opens
// "Show Return Filing Frequency", reads Monthly / Quarterly for each quarter, sends it to CA Desk and moves to the next GSTIN.
(() => {
  if (window.top !== window) return;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = m => new Promise(r => { try { chrome.runtime.sendMessage(m, x => r(x)); } catch { r(null); } });
  const visible = el => !!el && el.offsetParent !== null;
  const textOf = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  let job, stopped = false;

  function banner(msg, kind = 'run') {
    let b = document.getElementById('capm-freq');
    if (!b) {
      b = document.createElement('div'); b.id = 'capm-freq';
      b.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:2147483647;font:14px/1.45 system-ui,Segoe UI,sans-serif;padding:12px 16px;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.3);max-width:640px;display:flex;gap:14px;align-items:center;color:#fff';
      document.body.appendChild(b);
    }
    b.style.background = kind === 'err' ? '#9B1C1C' : kind === 'done' ? '#0B7A5C' : '#15233F';
    b.innerHTML = '';
    const t = document.createElement('div'); t.innerHTML = `<b>CA Desk — filing frequency</b><br>${msg}`; b.appendChild(t);
    const bt = document.createElement('div'); bt.style.cssText = 'display:flex;gap:6px';
    const mk = (label, fn) => { const x = document.createElement('button'); x.textContent = label; x.style.cssText = 'background:#fff;color:#15233F;border:0;border-radius:6px;padding:6px 12px;font-weight:600;cursor:pointer;white-space:nowrap'; x.onclick = fn; bt.appendChild(x); };
    if (kind === 'run' && job?.queue?.length > 1) mk('Skip', async () => { await send({ type: 'CAPM_FREQ_NEXT' }); location.reload(); });
    mk(kind === 'run' ? 'Stop' : 'Close', async () => { stopped = true; await send({ type: 'CAPM_FREQ_CLEAR' }); b.remove(); });
    b.appendChild(bt);
  }
  async function waitFor(fn, ms = 20000, step = 300) { const end = Date.now() + ms; while (Date.now() < end && !stopped) { const r = fn(); if (r) return r; await sleep(step); } return null; }
  const byText = re => [...document.querySelectorAll('button, a, input[type=button], [role=button]')].filter(visible).find(e => re.test(textOf(e) || e.value || ''));

  // quarter of a date in Indian FY terms
  const fyOf = d => { const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; };
  const qOf = d => { const m = d.getMonth() + 1; return m >= 4 && m <= 6 ? 1 : m <= 9 && m >= 7 ? 2 : m >= 10 ? 3 : 4; };
  function readTable() {
    const rows = [];
    for (const tr of [...document.querySelectorAll('tr')].filter(visible)) {
      const c = [...tr.querySelectorAll('td,th')].map(textOf);
      const freq = c.find(x => /^(monthly|quarterly)$/i.test(x)) || (c.join(' ').match(/\b(monthly|quarterly)\b/i) || [])[1];
      if (!freq || tr.querySelector('th') && !tr.querySelector('td')) continue;
      const fy = (c.join(' ').match(/\b(20\d{2})\s*-\s*(\d{2,4})\b/) || []).slice(1);
      const qm = c.join(' ').match(/quarter\s*([1-4])|\bQ([1-4])\b|(apr|jul|oct|jan)[a-z]*\s*-\s*(jun|sep|dec|mar)/i);
      const q = qm ? +(qm[1] || qm[2] || { apr: 1, jul: 2, oct: 3, jan: 4 }[qm[3].toLowerCase().slice(0, 3)]) : 0;
      rows.push({ fy: fy.length ? `${fy[0]}-${String(fy[1]).slice(-2)}` : '', q, freq: /quarter/i.test(freq) ? 'Quarterly' : 'Monthly', text: c.join(' | ').slice(0, 120) });
    }
    return rows;
  }

  async function run() {
    job = await send({ type: 'CAPM_FREQ_GET' });
    if (!job || stopped) return;
    const item = job.queue[job.i];
    if (!item) { await send({ type: 'CAPM_FREQ_CLEAR' }); banner(`Done — ${job.queue.length} GSTIN${job.queue.length === 1 ? '' : 's'} checked. The filing frequency is updated in CA Desk.`, 'done'); return; }
    const pos = `${job.i + 1} of ${job.queue.length}`;
    const g = await waitFor(() => document.getElementById('for_gstin'), 20000);
    if (!g) return banner('The Search Taxpayer page did not load. Reload this page.', 'err');
    g.focus(); g.value = item.gstin;
    g.dispatchEvent(new Event('input', { bubbles: true })); g.dispatchEvent(new Event('change', { bubbles: true }));
    g.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: item.gstin.slice(-1) }));
    const cap = await waitFor(() => { const c = document.getElementById('fo-captcha'); return visible(c) ? c : null; }, 10000);
    if (!cap) return banner('The CAPTCHA box did not appear. Click in the GSTIN box, press End and type the CAPTCHA.', 'err');
    cap.value = ''; cap.focus();
    banner(`<b>${item.name || ''}</b> · ${item.gstin} (${pos})<br>Type the CAPTCHA — it searches as soon as you type the 6th character.`);
    // search when 6 characters are typed
    const typed = await new Promise(res => {
      const h = () => { if (cap.value.replace(/\s/g, '').length >= 6) { cap.removeEventListener('input', h); res(true); } };
      cap.addEventListener('input', h);
      document.getElementById('lotsearch')?.addEventListener('click', () => res(true), { once: true });
    });
    if (!typed || stopped) return;
    await sleep(300);
    if (cap.value.replace(/\s/g, '').length >= 6) document.getElementById('lotsearch')?.click();
    banner(`<b>${item.name || ''}</b> · ${item.gstin} (${pos})<br>Searching…`);
    const capErr = () => [...document.querySelectorAll('.err, .alert-danger, .error')].filter(visible).some(e => /captcha|letters shown|characters shown/i.test(textOf(e)));
    const btn = await waitFor(() => byText(/filing\s*frequency/i) || (capErr() ? 'bad' : null), 25000);
    if (btn === 'bad' || !btn) {
      if (btn === 'bad') { banner(`Wrong CAPTCHA for ${item.gstin}. Type the new CAPTCHA…`); await sleep(1500); location.reload(); return; }
      return banner(`No result for ${item.gstin}. If the CAPTCHA was wrong, press Skip or reload to try again.`, 'run');
    }
    btn.click();
    banner(`<b>${item.name || ''}</b> · ${item.gstin} (${pos})<br>Reading the filing frequency…`);
    const rows = await waitFor(() => { const r = readTable(); return r.length ? r : null; }, 20000, 500);
    if (!rows) return banner(`The filing frequency table did not show for ${item.gstin}. Press Skip to move on.`, 'run');
    const now = new Date(), fy = fyOf(now), q = qOf(now);
    const cur = rows.find(r => r.fy === fy && r.q === q) || rows.filter(r => r.fy === fy).pop() || rows[rows.length - 1];
    const legal = (document.body.innerText.match(/Legal Name of Business\s*\n?\s*([^\n]+)/i) || [])[1] || '';
    await send({ type: 'CAPM_FREQ_RESULT', result: { cid: item.cid, gstin: item.gstin, name: item.name, freq: cur.freq === 'Quarterly' ? 'QRMP' : 'Monthly', fy: cur.fy, q: cur.q, table: rows.map(({ fy, q, freq }) => ({ fy, q, freq })), legal: legal.trim(), at: Date.now() } });
    banner(`<b>${item.name || ''}</b> · ${item.gstin}: <b>${cur.freq === 'Quarterly' ? 'Quarterly (QRMP)' : 'Monthly'}</b> — saved to CA Desk.${job.i + 1 < job.queue.length ? ' Next GSTIN…' : ''}`, job.i + 1 < job.queue.length ? 'run' : 'done');
    await send({ type: 'CAPM_FREQ_NEXT' });
    await sleep(2200);
    if (!stopped) location.reload();
  }
  if (/services\.gst\.gov\.in\/services\/searchtp/i.test(location.href)) setTimeout(run, 800);
})();
