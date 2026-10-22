/*
 * Loaded into the service worker (vite.config.js importScripts).
 *
 * Tapping a cook timer's "Timer done" brings CookTrace back: the window
 * that is already open when there is one, else a new one (#77).
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const scope = self.registration.scope;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((c) => c.url.startsWith(scope));
    if (open) return open.focus();
    return self.clients.openWindow(scope);
  })());
});
