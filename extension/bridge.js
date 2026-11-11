// Runs on the CA Desk page. Tells the page the extension is installed and relays Login clicks.
document.documentElement.dataset.capmExt = '1';
document.documentElement.dataset.capmTally = '1';
document.documentElement.dataset.capmVer = chrome.runtime.getManifest().version;
window.addEventListener('message', e => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data;
  if (d && d.type === 'CAPM_TALLY' && typeof d.url === 'string' && typeof d.xml === 'string') { // read-only Tally export request
    chrome.runtime.sendMessage({ type: 'CAPM_TALLY', url: d.url, xml: d.xml }, r => {
      const res = r || { ok: false, error: chrome.runtime.lastError?.message || 'no reply' };
      window.postMessage({ type: 'CAPM_TALLY_RES', id: d.id, ...res }, location.origin);
    });
    return;
  }
  if (!d || d.type !== 'CAPM_LOGIN' || typeof d.url !== 'string') return;
  chrome.runtime.sendMessage({ type: 'CAPM_LOGIN', url: d.url, username: d.username || '', password: d.password || '', extra: d.extra || {} });
});
