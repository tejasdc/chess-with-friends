import { defineConfig, devices } from "@playwright/test";
import { release } from "node:os";

const webkitRunnable = !(process.platform === "darwin" && release().startsWith("25."));
const port = process.env.PLAYWRIGHT_PORT || "8787";

// Two projects: chromium runs the full v1 mechanics suite. mobile-webkit
// runs the mobile-viewport layout tests to catch iOS-Safari-specific
// behavior (this app's primary surface). Playwright's WebKit binary
// currently segfaults on Darwin 25 pre-release (upstream); when that's
// resolved the mobile-webkit project runs automatically.
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
  webServer: {
    command: `npm run build && wrangler d1 migrations apply chess-with-friends --local --persist-to=.wrangler/state-${port} && wrangler dev --local --persist-to=.wrangler/state-${port} --port ${port}`,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
