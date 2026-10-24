// Holds the login for the portal tab just opened, in memory only (storage.session), for 5 minutes.
const TTL = 5 * 60 * 1000;
const key = url => 'pending:' + new URL(url).hostname;

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
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
