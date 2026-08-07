const PRECACHE_MANIFEST = self.__WB_MANIFEST;
const CACHE_NAME = "chess-with-friends-precache";
const PUSH_TYPES = new Set(["friend_request", "challenge", "challenge_accepted", "scheduled_start", "call_invite"]);

function precacheUrls() {
  const urls = PRECACHE_MANIFEST.map((entry) => entry.url);
  return [...new Set(["/", ...urls])];
}

self.addEventListener("install", (event) => {
  // Do not call skipWaiting() here. A waiting SW may only activate after the
  // client-side active-game gate posts { type: "SKIP_WAITING" }, otherwise a
  // deploy can silently reload a player mid-move.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(precacheUrls()))
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
    const cache = await caches.open(CACHE_NAME);
    const expected = new Set(precacheUrls().map((url) => new URL(url, self.location.href).href));
    await Promise.all((await cache.keys()).map((request) => (
      expected.has(request.url) ? undefined : cache.delete(request)
    )));
    await self.clients.claim();
  })());
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
      const subscription = await self.registration.pushManager.getSubscription();
      const response = await fetch("/api/push/pending", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: subscription?.endpoint || "" }),
      });
      payload = response.ok ? await response.json() : null;
    } catch {
      payload = null;
    }
  }

  if (!payload || !PUSH_TYPES.has(payload.type)) return;

  // The server's payload.body IS now the human-first title line
  // ("@handle invited you to a game" etc.). One line, no separate body —
  // iOS appends "from two chairs" after the title so we don't
  // double up. Fallback to the old generic titles only if payload.body
  // is missing (should not happen with the current server).
  const title = payload.body || (
    payload.type === "friend_request" ? "Friend request" :
    payload.type === "challenge" ? "Game challenge" :
    payload.type === "challenge_accepted" ? "Your game is ready" :
    payload.type === "call_invite" ? "Your friend wants to talk" :
    "Your game is starting"
  );

  await self.registration.showNotification(title, {
    icon: "/apple-touch-icon.png",
    badge: "/icon.svg",
    tag: payload.id || `${payload.type}:${payload.createdAt || Date.now()}`,
    data: { url: payload.url || "/" },
  });

  if (payload.id) {
    try {
      const subscription = await self.registration.pushManager.getSubscription();
      await fetch("/api/push/pending", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: subscription?.endpoint || "", ackId: payload.id }),
      });
    } catch {
      // The item remains queued server-side if the ack cannot be recorded.
    }
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(clients.openWindow(url));
});
