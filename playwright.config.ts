import { defineConfig, devices } from "@playwright/test";

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
    baseURL: "http://localhost:8787",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-webkit",
      grep: /board holds a stable size|notification prompt/,
      use: { ...devices["iPhone 13"] },
    },
  ],
  webServer: {
    command: "npm run worker:dev",
    url: "http://localhost:8787/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
