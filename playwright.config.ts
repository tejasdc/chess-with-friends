import { defineConfig, devices } from "@playwright/test";
import { release } from "node:os";

const webkitRunnable = !(process.platform === "darwin" && release().startsWith("25."));
const port = process.env.PLAYWRIGHT_PORT || "8787";
const fixturePort = process.env.PLAYWRIGHT_FIXTURE_PORT || String(Number(port) + 1);
const fixtureURL = `http://localhost:${fixturePort}`;

// Routed client fixtures use the production preview. Integrated mechanics,
// adversity and notifications use the local Worker; PWA updates have their own fixture.
// Playwright's WebKit binary currently segfaults on Darwin 25 pre-release;
// the existing mobile/replay WebKit projects run when the host supports them.
export default defineConfig({
  testDir: "tests",
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    ...[
      { name: "replay-desktop-chromium", device: "Desktop Chrome" },
      { name: "replay-mobile-chromium", device: "Pixel 7" },
      { name: "replay-desktop-webkit", device: "Desktop Safari" },
      { name: "replay-mobile-webkit", device: "iPhone 14" },
    ].filter((project) => webkitRunnable || !project.name.endsWith("webkit")).map((project) => ({
      name: project.name,
      testMatch: /opponent-replay\.spec\.ts$/,
      use: { ...devices[project.device], baseURL: fixtureURL },
    })),
    {
      name: "orientation-chromium",
      testMatch: /orientation\.spec\.ts$/,
      use: { browserName: "chromium", baseURL: fixtureURL },
    },
    {
      name: "orientation-webkit",
      testMatch: /orientation\.spec\.ts$/,
      use: { browserName: "webkit", baseURL: fixtureURL },
    },
    {
      name: "chromium",
      testMatch: /e2e\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    // Hostile-conditions harness — simulates what a real phone does
    // (socket death, offline/online, hidden/visible cycles, rapid
    // input, CPU throttling). A round is not shippable unless this
    // project is green. Runs as its own project so mechanics failures
    // and adversity failures are triaged separately.
    {
      name: "adversity",
      testMatch: /adversity\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "pwa",
      testMatch: /pwa-update\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    ...(webkitRunnable ? [{
      name: "mobile-webkit",
      testMatch: /e2e\.spec\.ts$/,
      grep: /board holds a stable size|notification prompt/,
      use: { ...devices["iPhone 13"] },
    }] : []),
  ],
  webServer: [{
    name: "Worker",
    command: `npm run build && wrangler dev --local --persist-to=.wrangler/state-${port} --port ${port}`,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  }, {
    name: "Fixtures",
    command: `vite preview --host localhost --port ${fixturePort} --strictPort`,
    url: fixtureURL,
    reuseExistingServer: false,
    timeout: 60_000,
  }],
});
