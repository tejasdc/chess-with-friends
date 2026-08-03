// Render public/icon.svg to public/apple-touch-icon.png at 180×180.
// iOS ignores SVG for the home-screen icon; the 180×180 PNG is the
// standard apple-touch-icon size that Retina iPhones sharpen.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const src = resolve("public/icon.svg");
const svg = readFileSync(src, "utf8");
const html = `<!doctype html><html><head><style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body { width: 180px; height: 180px; display: grid; place-items: center; }
  svg { width: 180px; height: 180px; display: block; }
</style></head><body>${svg}</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 180, height: 180 },
  deviceScaleFactor: 2, // Retina — output is 360×360 but scaled to 180 CSS pixels
});
const page = await ctx.newPage();
await page.setContent(html);
await page.waitForTimeout(200);
const buf = await page.screenshot({ omitBackground: true, type: "png", clip: { x: 0, y: 0, width: 180, height: 180 } });
mkdirSync("public", { recursive: true });
writeFileSync("public/apple-touch-icon.png", buf);
console.log("wrote public/apple-touch-icon.png", buf.length, "bytes");

// Also render 512×512 for maskable manifest icon.
const page2 = await (await browser.newContext({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 })).newPage();
await page2.setContent(html.replace("width: 180px; height: 180px", "width: 512px; height: 512px").replaceAll("width: 180px; height: 180px", "width: 512px; height: 512px"));
await page2.waitForTimeout(200);
const buf2 = await page2.screenshot({ omitBackground: true, type: "png", clip: { x: 0, y: 0, width: 512, height: 512 } });
writeFileSync("public/icon-512.png", buf2);
console.log("wrote public/icon-512.png", buf2.length, "bytes");

await browser.close();
