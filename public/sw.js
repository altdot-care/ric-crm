// Minimal service worker: exists to satisfy "Add to Home Screen" installability criteria (Chrome/
// Android requires a registered service worker with a fetch handler before it will offer install),
// and to receive push notifications.
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

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* Always show a visible fallback. */ }
  event.waitUntil(self.registration.showNotification(data.title || 'RIC Sales CRM', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png', // Android shows only the alpha channel: a white silhouette, not the logo tile
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let url = new URL('/', self.location.origin);
  try {
    const target = new URL(event.notification.data?.url || '/', url);
    if (target.origin === url.origin) url = target;
  } catch { /* Fall back to dashboard for malformed URLs. */ }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => client.url === url.href);
    if (existing) return existing.focus();
    return self.clients.openWindow(url.href);
  })());
});
