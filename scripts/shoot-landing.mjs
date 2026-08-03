// One-off screenshot script — runs inside the project so playwright resolves.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = "tmp/reviews/screens-r2";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

for (const [label, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
]) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(400);
  await page.waitForSelector(".auth-scene .board", { timeout: 5000 });
  const file = join(OUT, `landing-${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log("wrote", file);
  await ctx.close();
}

await browser.close();
