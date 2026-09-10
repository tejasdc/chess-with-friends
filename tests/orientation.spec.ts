import { expect, test, type Page } from "@playwright/test";

// Keep routed fixtures authoritative; the real service worker has its own suite.
test.use({ serviceWorkers: "block" });

type OrientationSource = "modern" | "legacy" | "dimensions";
declare global {
  interface Window {
    orientationTest: {
      rotate: (landscape: boolean) => void;
      lockRequests: string[];
      input?: Element | null;
    };
  }
}

// Playwright resizes viewports but cannot physically rotate a phone or grant OS locks.
// Supply device signals independently so keyboard resizing cannot fake a rotation.
async function deviceOrientation(page: Page, source: OrientationSource, landscape = false, acceptsLock = false) {
  await page.addInitScript(({ source, landscape, acceptsLock }) => {
    const orientation = new EventTarget();
    const lockRequests: string[] = [];
    const rotate = (next: boolean) => {
      landscape = next;
      orientation.dispatchEvent(new Event("change"));
      window.dispatchEvent(new Event("orientationchange"));
      window.dispatchEvent(new Event("resize"));
    };
    Object.defineProperties(screen, {
      width: { configurable: true, get: () => landscape ? 844 : 390 },
      height: { configurable: true, get: () => landscape ? 390 : 844 },
      orientation: { configurable: true, value: source === "modern" ? orientation : undefined },
    });
    Object.defineProperty(window, "orientation", {
      configurable: true,
      get: () => source === "legacy" ? (landscape ? 90 : 0) : undefined,
    });
    Object.defineProperties(orientation, {
      type: { get: () => landscape ? "landscape-primary" : "portrait-primary" },
      lock: { value: async (requested: string) => {
        lockRequests.push(requested);
        if (!acceptsLock) throw new DOMException("Lock unavailable", "NotSupportedError");
        rotate(false);
      } },
    });
    window.orientationTest = { rotate, lockRequests };
  }, { source, landscape, acceptsLock });
}

async function expectReadablePieces(page: Page) {
  await expect.poll(() => page.locator(".landing-piece.live").evaluateAll(pieces =>
    pieces.length > 0 && pieces.every(piece =>
      piece.getBoundingClientRect().width > 20 && parseFloat(getComputedStyle(piece).fontSize) > 20,
    ),
  )).toBe(true);
}

const errors = new WeakMap<Page, string[]>();

test("the served install manifest requests portrait and retains the app identity", async ({ page, request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest.orientation).toBe("portrait");
  expect(manifest.name).toBe("two chairs");
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: "/icon-512.png" }),
  ]));
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
});

test.beforeEach(async ({ page }) => {
  const pageErrors: string[] = [];
  errors.set(page, pageErrors);
  page.on("pageerror", error => pageErrors.push(error.message));
  // Production analytics rejects localhost; orientation tests must not send telemetry.
  await page.route("https://static.cloudflareinsights.com/beacon.min.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "",
  }));
  await page.route("**/api/**", route => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: "No account" }),
  }));
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

test.describe("touch device", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  for (const source of ["modern", "legacy", "dimensions"] as const) {
    test(`${source}: blocks landscape and restores the mounted form in portrait`, async ({ page }, testInfo) => {
      await deviceOrientation(page, source);
      await page.goto("/");
      const handle = page.getByRole("textbox", { name: "Handle" });
      await handle.fill("portrait_draft");
      await expectReadablePieces(page);
      await page.evaluate(() => { window.orientationTest.input = document.querySelector("input"); });
      await page.setViewportSize({ width: 844, height: 390 });
      await page.evaluate(() => window.orientationTest.rotate(true));

      await expect(page.getByRole("heading", { name: "Turn your device upright" })).toBeVisible();
      await expect(handle).toBeHidden();
      await expect(page.getByRole("button")).toHaveCount(0);
      await expect(page.getByRole("textbox")).toHaveCount(0);
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement === window.orientationTest.input)).toBe(false);
      const notice = page.getByRole("status");
      await expect(notice).toHaveText("Turn your device uprightRotate to portrait to continue.");
      expect(await notice.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight })))
        .toEqual({ width: 844, height: 390 });
      await page.screenshot({ path: testInfo.outputPath(`${source}-landscape.png`) });

      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => window.orientationTest.rotate(false));
      await expect(handle).toBeVisible();
      await expect(handle).toHaveValue("portrait_draft");
      await expectReadablePieces(page);
      expect(await page.evaluate(() => document.querySelector("input") === window.orientationTest.input)).toBe(true);
      await expect(page.getByRole("heading", { name: "Turn your device upright" })).toBeHidden();
      await page.screenshot({ path: testInfo.outputPath(`${source}-portrait.png`) });
    });

    test(`${source}: a portrait keyboard viewport does not block typing`, async ({ page }) => {
      await deviceOrientation(page, source);
      await page.goto("/");
      const handle = page.getByRole("textbox", { name: "Handle" });
      await handle.fill("keyboard");
      await page.setViewportSize({ width: 390, height: 300 });
      await expect(handle).toBeVisible();
      await handle.pressSequentially("_works");
      await expect(handle).toHaveValue("keyboard_works");
      await expect(page.getByRole("heading", { name: "Turn your device upright" })).toBeHidden();
    });
  }

  test("starts blocked in landscape when the browser rejects portrait locking", async ({ page }) => {
    await deviceOrientation(page, "modern", true);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto("/inspirations");
    await expect(page.getByRole("heading", { name: "Turn your device upright" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.orientationTest.lockRequests)).toContain("portrait");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.orientationTest.rotate(false));
    await expect(page.getByRole("heading", { name: "Inspirations", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/inspirations$/);
  });

  test("uses the portrait lock when the browser accepts it", async ({ page }) => {
    await deviceOrientation(page, "modern", true, true);
    await page.goto("/");
    await expect(page.getByRole("textbox", { name: "Handle" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.orientationTest.lockRequests)).toContain("portrait");
    await expect(page.getByRole("heading", { name: "Turn your device upright" })).toBeHidden();
  });
});

test("desktop stays usable in wide and short windows without requesting a lock", async ({ page }, testInfo) => {
  await deviceOrientation(page, "modern", true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Handle" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Turn your device upright" })).toBeHidden();
  await expectReadablePieces(page);
  await page.screenshot({ path: testInfo.outputPath("desktop.png") });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByRole("textbox", { name: "Handle" })).toBeVisible();
  expect(await page.evaluate(() => window.orientationTest.lockRequests)).toEqual([]);
});
