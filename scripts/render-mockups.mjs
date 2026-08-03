// Render the six mockup HTML pages into PNGs at the specified viewports.
// Serves the mockup src directory over an ephemeral http.server so the
// shared _tokens.css and _shared.js links resolve.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const OUT = "tmp/reviews/mockups";
const SRC = join(OUT, "src");
mkdirSync(OUT, { recursive: true });

// Ephemeral static server for the src dir
const port = 4180;
const server = spawn("python3", ["-m", "http.server", String(port), "--directory", SRC], { stdio: "ignore" });
await sleep(500);

const jobs = [
  ["mock-a-landing-mobile.html",           "mock-a-landing-mobile.png",           390, 844],
  ["mock-a-landing-desktop.html",          "mock-a-landing-desktop.png",         1440, 900],
  ["mock-b-game-mobile.html",              "mock-b-game-mobile.png",              390, 844],
  ["mock-c-dashboard-mobile.html",         "mock-c-dashboard-mobile.png",         390, 844],
  ["mock-d-landing-villalba-mobile.html",  "mock-d-landing-villalba-mobile.png",  390, 844],
  ["mock-d-landing-villalba-desktop.html", "mock-d-landing-villalba-desktop.png",1440, 900],
  ["mock-e-game-villalba-mobile.html",     "mock-e-game-villalba-mobile.png",     390, 844],
  ["mock-f-dashboard-villalba-mobile.html","mock-f-dashboard-villalba-mobile.png", 390, 844],
];

const browser = await chromium.launch();
try {
  for (const [html, out, w, h] of jobs) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error(`[${html}] pageerror:`, e.message));
    await page.goto(`http://127.0.0.1:${port}/${html}`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await sleep(400);
    const path = join(OUT, out);
    await page.screenshot({ path, clip: { x: 0, y: 0, width: w, height: h } });
    console.log("wrote", path);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
