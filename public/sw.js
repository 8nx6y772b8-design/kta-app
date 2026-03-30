// ─── Service Worker for Web Push Notifications ───────────────────────────────
// Place this file at: public/sw.js  (Vite serves public/ at the root)

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Kiwi Trade Apprentices', body: event.data.text() };
  }

  const { title = 'Kiwi Trade Apprentices', body = '', type = 'info', url = '/' } = payload;

  const icons = {
    approval:        '✓',
    decline:         '✕',
    licence_expiry:  '⚠',
    broadcast:       '📢',
    info:            '◈',
  };

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:  '/favicon.ico',
      badge: '/favicon.ico',
      tag:   type,           // collapses duplicate type notifications
      data:  { url },
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Focus existing tab if already open
      for (const client of list) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      // Otherwise open a new tab
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
