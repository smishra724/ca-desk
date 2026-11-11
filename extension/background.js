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
