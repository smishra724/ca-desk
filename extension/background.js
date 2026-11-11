// Holds the login for the portal tab just opened, in memory only (storage.session), for 5 minutes.
const TTL = 5 * 60 * 1000;
const key = url => 'pending:' + new URL(url).hostname;

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'CAPM_TALLY') { // Tally on this computer only, export (read) requests only
    let u; try { u = new URL(msg.url); } catch { return; }
    if (u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname)) return;
    if (!/<TALLYREQUEST>\s*Export\s*<\/TALLYREQUEST>/i.test(msg.xml)) { reply({ ok: false, error: 'only export requests are allowed' }); return; }
    fetch(u.origin, { method: 'POST', body: msg.xml, headers: { 'Content-Type': 'text/xml' } })
      .then(r => r.arrayBuffer()).then(b => { const t = new TextDecoder('utf-8').decode(b); reply({ ok: true, text: t.includes('\u0000') ? new TextDecoder('utf-16le').decode(b) : t }); })
      .catch(e => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'CAPM_G1') { // start the GSTR-1 autopilot: keep the job for 2 hours, open the GST login
    let host; try { host = new URL(msg.url).hostname; } catch { return; }
    if (!/\.gst\.gov\.in$/.test(host)) return;
    chrome.storage.session.set({ g1job: { ...msg.job, stage: 'login', t: Date.now() }, [key(msg.url)]: { u: msg.username, p: msg.password, extra: {}, t: Date.now() } })
      .then(() => chrome.tabs.create({ url: msg.url }));
    return;
  }
  if (msg.type === 'CAPM_JOB_GET' && sender.url && /\.gst\.gov\.in\//.test(sender.url)) {
    chrome.storage.session.get('g1job').then(r => reply(r.g1job && Date.now() - r.g1job.t < 2 * 3600e3 ? r.g1job : null));
    return true;
  }
  if (msg.type === 'CAPM_JOB_SET' && sender.url && /\.gst\.gov\.in\//.test(sender.url)) {
    chrome.storage.session.get('g1job').then(r => r.g1job && chrome.storage.session.set({ g1job: { ...r.g1job, ...msg.job } })).then(() => reply(true));
    return true;
  }
  if ((msg.type === 'CAPM_G1_ARN' || msg.type === 'CAPM_G1_PDF') && sender.url && /\.gst\.gov\.in\//.test(sender.url)) {
    saveResult(msg).then(() => reply(true)); return true;
  }
  if (msg.type === 'CAPM_G1_PENDING') { chrome.storage.local.get('g1results').then(r => reply(Object.values(r.g1results || {}))); return true; }
  if (msg.type === 'CAPM_G1_ACK') { chrome.storage.local.get('g1results').then(r => { const x = r.g1results || {}; delete x[msg.id]; return chrome.storage.local.set({ g1results: x }); }).then(() => reply(true)); return true; }
  if (msg.type === 'CAPM_JOB_CLEAR') { chrome.storage.session.remove('g1job').then(() => reply(true)); return true; }
  if (msg.type === 'CAPM_LOGIN') {
    let host;
    try { host = new URL(msg.url).hostname; } catch { return; }
    if (!/(\.gov\.in|^ewaybillgst\.gov\.in)$/.test(host)) return; // government portals only
    chrome.storage.session.set({ [key(msg.url)]: { u: msg.username, p: msg.password, extra: msg.extra, t: Date.now() } })
      .then(() => chrome.tabs.create({ url: msg.url }));
    return;
  }
  if (msg.type === 'CAPM_GET' && sender.url) {
    const k = key(sender.url);
    chrome.storage.session.get(k).then(r => {
      const v = r[k];
      reply(v && Date.now() - v.t < TTL ? v : null);
    });
    return true;
  }
  if (msg.type === 'CAPM_DONE' && sender.url) {
    chrome.storage.session.remove(key(sender.url));
  }
});

// ARN / filed PDF from the portal → kept until CA Desk confirms it saved them (survives closing CA Desk)
async function saveResult(msg) {
  const { g1job } = await chrome.storage.session.get('g1job'); if (!g1job) return;
  const id = `${g1job.cid}|${g1job.key}`;
  const { g1results = {} } = await chrome.storage.local.get('g1results');
  const r = g1results[id] || { id, cid: g1job.cid, key: g1job.key, alt: g1job.alt, form: g1job.form, period: g1job.period, due: g1job.due, ret: g1job.ret, gstin: g1job.gstin, fp: g1job.fp };
  if (msg.type === 'CAPM_G1_ARN') Object.assign(r, { arn: msg.arn, filedOn: msg.filedOn });
  if (msg.type === 'CAPM_G1_PDF') { r.pdf = msg.b64; r.pdfName = msg.name || `${g1job.ret}_${g1job.gstin}_${g1job.fp}_filed.pdf`; }
  g1results[id] = r;
  await chrome.storage.local.set({ g1results });
  if (msg.type === 'CAPM_G1_PDF') await chrome.storage.session.set({ g1job: { ...g1job, pdfDone: true } });
  for (const t of await chrome.tabs.query({ url: 'https://smishra724.github.io/*' })) chrome.tabs.sendMessage(t.id, { type: 'CAPM_G1_RESULT', result: r }).catch(() => {});
}
// PDFs the portal downloads from a link (not built in the page): fetch the same link with the portal session
chrome.downloads.onCreated.addListener(async d => {
  try {
    const { g1job } = await chrome.storage.session.get('g1job');
    if (!g1job || !['pdf', 'filing'].includes(g1job.stage) || !/^https:\/\/[^/]*\.gst\.gov\.in\//.test(d.url || '')) return;
    const b = await (await fetch(d.url, { credentials: 'include' })).arrayBuffer();
    const u8 = new Uint8Array(b); if (String.fromCharCode(...u8.slice(0, 4)) !== '%PDF') return;
    let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode(...u8.subarray(i, i + 32768));
    await saveResult({ type: 'CAPM_G1_PDF', b64: btoa(s), name: (d.filename || '').split(/[\\/]/).pop() });
  } catch { /* leave the normal download alone */ }
});
