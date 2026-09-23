// Registered as a classic script (no { type: "module" }), so this file must stay a script:
// no import/export, or the compiled sw.js fails to parse and never registers.
const sw = self as unknown as ServiceWorkerGlobalScope;

type Message = { title: string; body: string; url?: string; tag?: string; renotify?: boolean };

sw.addEventListener("install", () => sw.skipWaiting());
sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim()));

sw.addEventListener("push", (e) => {
  const msg: Message = e.data?.json() ?? { title: "Vaskekjeller", body: "" };
  const options: NotificationOptions & { renotify?: boolean } = {
    body: msg.body,
    tag: msg.tag,
    renotify: msg.renotify,
    icon: "/icon.svg",
    data: { url: msg.url ?? "/" },
  };
  e.waitUntil(sw.registration.showNotification(msg.title, options));
});

sw.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url ?? "/", sw.location.origin).href;
  e.waitUntil(
    (async () => {
      const all = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = all.find((c) => new URL(c.url).pathname === new URL(url).pathname);
      if (existing) {
        await existing.navigate(url);
        return existing.focus();
      }
      return sw.clients.openWindow(url);
    })(),
  );
});
