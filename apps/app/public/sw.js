/**
 * Service Worker — handles web push notification display and click actions.
 */

self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Alia', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: data,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const url = data?.conversationId ? `/c/${data.conversationId}` : '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Prefer a focused/visible tab, then any matching tab
      const sorted = windowClients
        .filter((c) => c.url.includes(self.location.origin))
        .sort((a, b) => (b.focused ? 1 : 0) - (a.focused ? 1 : 0) || (b.visibilityState === 'visible' ? 1 : 0) - (a.visibilityState === 'visible' ? 1 : 0));
      if (sorted.length > 0 && 'focus' in sorted[0]) {
        sorted[0].navigate(url);
        return sorted[0].focus();
      }
      // Otherwise open a new window
      return clients.openWindow(url);
    }),
  );
});
