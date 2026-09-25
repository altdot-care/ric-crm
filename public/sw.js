// Minimal service worker: exists to satisfy "Add to Home Screen" installability criteria (Chrome/
// Android requires a registered service worker with a fetch handler before it will offer install),
// and as the foundation the push-notifications phase attaches a 'push' listener to later.
//
// Deliberately does NOT cache pages or API responses. This app shows live sales pipeline data —
// serving a stale cached version while "offline" would be actively misleading, not helpful, so
// there is no offline mode here, only pass-through.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
