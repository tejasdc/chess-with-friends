const CACHE_NAME = "chess-with-friends-v1";
const PUSH_TYPES = new Set(["friend_request", "challenge", "scheduled_start"]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(["/", "/manifest.webmanifest", "/icon.svg"]))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(async () => {
      const cached = await caches.match(event.request);
      return cached || caches.match("/");
    })
  );
});

self.addEventListener("push", (event) => {
  event.waitUntil(showPolicyNotification(event));
});

async function showPolicyNotification(event) {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }

  if (!payload) {
    try {
      const response = await fetch("/api/push/pending", { credentials: "include" });
      payload = response.ok ? await response.json() : null;
    } catch {
      payload = null;
    }
  }

  if (!payload || !PUSH_TYPES.has(payload.type)) return;

  const title =
    payload.type === "friend_request"
      ? "Friend request"
      : payload.type === "challenge"
        ? "Game challenge"
        : "Scheduled game";

  await self.registration.showNotification(title, {
    body: payload.body || "Open the app when you are ready.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: payload.type,
    data: { url: payload.url || "/" },
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(clients.openWindow(url));
});
