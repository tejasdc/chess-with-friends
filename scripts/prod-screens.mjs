import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const out = "/Users/tejasdc/workspace/chess-with-friends/tmp/reviews/screens-claude";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
try {
  for (const [name, w, h] of [["prod-mobile-auth", 390, 844], ["prod-desktop-auth", 1200, 900]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.goto("https://chess.tejas.nyc/");
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
    console.log("shot", name);
    await ctx.close();
  }
} finally {
  await browser.close();
}
