// Minimal service worker so CA Desk can be installed as an app. Always uses the network
// (no offline cache), so updates appear on the next reload.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
