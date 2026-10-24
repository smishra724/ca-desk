// Runs on the CA Desk page. Tells the page the extension is installed and relays Login clicks.
document.documentElement.dataset.capmExt = '1';
window.addEventListener('message', e => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data;
  if (!d || d.type !== 'CAPM_LOGIN' || typeof d.url !== 'string') return;
  chrome.runtime.sendMessage({ type: 'CAPM_LOGIN', url: d.url, username: d.username || '', password: d.password || '', extra: d.extra || {} });
});
