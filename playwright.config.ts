import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:8787",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command: "npm run worker:dev",
    url: "http://127.0.0.1:8787/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
