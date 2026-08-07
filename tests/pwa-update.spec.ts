import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";

test("silent PWA update waits while game is active and reloads after safe visibility gain", async ({ browser }) => {
  const context = await browser.newContext();
  let swVersion = 1;
  const server = await startPwaFixtureServer(() => swVersion);

  try {
    const page = await context.newPage();
    await page.goto(`${server.origin}/pwa-update-test/`);

    await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.includes("/pwa-update-test/sw.js"));
    await expect(page.locator("#game")).toHaveText("active");
    await expect.poll(() => page.evaluate(() => window.__pwaTestControlledVersion())).toBe(1);
    const reloadsAfterV1 = await page.evaluate(() => Number(sessionStorage.getItem("pwa-test-reloads") || "0"));

    swVersion = 2;
    await page.evaluate(() => window.__pwaTestUpdate());
    await page.waitForFunction(() => window.__pwaTestNeedRefresh === true);
    await page.waitForTimeout(500);
    await expect.poll(() => page.evaluate(() => Number(sessionStorage.getItem("pwa-test-reloads") || "0"))).toBe(reloadsAfterV1);
    await expect.poll(() => page.evaluate(() => window.__pwaTestControlledVersion())).toBe(1);

    const reloaded = page.waitForEvent("framenavigated");
    await page.evaluate(() => {
      window.__pwaTestCompleteGame();
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await reloaded;
    await expect.poll(() => page.evaluate(() => Number(sessionStorage.getItem("pwa-test-reloads") || "0"))).toBeGreaterThan(reloadsAfterV1);
    await expect.poll(() => page.evaluate(() => window.__pwaTestControlledVersion())).toBe(2);
  } finally {
    await context.close();
    await server.close();
  }
});

async function startPwaFixtureServer(version: () => number): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/pwa-update-test/" || url.pathname === "/pwa-update-test/index.html") {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-cache" });
      response.end(testPageHtml());
      return;
    }
    if (url.pathname === "/pwa-update-test/sw.js") {
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-cache" });
      response.end(testServiceWorker(version()));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind to a TCP port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function testPageHtml() {
  return `<!doctype html>
<html>
  <body>
    <main id="game">active</main>
    <script>
      let activeGame = true;
      let waitingUpdate = false;
      let applying = false;
      let registration = null;
      window.__pwaTestNeedRefresh = false;
      window.__pwaTestCompleteGame = () => {
        activeGame = false;
        document.getElementById("game").textContent = "completed";
      };
      window.__pwaTestControlledVersion = async () => {
        const response = await fetch("/pwa-update-test/version", { cache: "no-store" });
        return (await response.json()).version;
      };
      function maybeApply() {
        if (!waitingUpdate || applying || activeGame || document.visibilityState !== "visible") return;
        const waiting = registration && registration.waiting;
        if (!waiting) return;
        applying = true;
        waiting.postMessage({ type: "SKIP_WAITING" });
      }
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        sessionStorage.setItem("pwa-test-reloads", String(Number(sessionStorage.getItem("pwa-test-reloads") || "0") + 1));
        location.reload();
      });
      navigator.serviceWorker.register("/pwa-update-test/sw.js", { scope: "/pwa-update-test/" }).then(async (reg) => {
        registration = reg;
        window.__pwaTestUpdate = () => reg.update();
        if (reg.waiting && !navigator.serviceWorker.controller) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
          return;
        }
        reg.addEventListener("updatefound", () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              waitingUpdate = true;
              window.__pwaTestNeedRefresh = true;
              maybeApply();
            }
          });
        });
        if (reg.waiting && navigator.serviceWorker.controller) {
          waitingUpdate = true;
          window.__pwaTestNeedRefresh = true;
          maybeApply();
        }
      });
      document.addEventListener("visibilitychange", maybeApply);
    </script>
  </body>
</html>`;
}

function testServiceWorker(version: number) {
  return `
const VERSION = ${version};
self.addEventListener("install", () => {});
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === "/pwa-update-test/version") {
    event.respondWith(Response.json({ version: VERSION }));
  }
});
`;
}

declare global {
  interface Window {
    __pwaTestNeedRefresh: boolean;
    __pwaTestUpdate: () => Promise<void>;
    __pwaTestCompleteGame: () => void;
    __pwaTestControlledVersion: () => Promise<number>;
  }
}
