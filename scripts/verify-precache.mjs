import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, relative, resolve, sep } from "node:path";

const distDir = resolve("dist");
const swPath = join(distDir, "sw.js");

if (!existsSync(swPath)) {
  fail(`Missing generated service worker at ${relative(process.cwd(), swPath)}.`);
}

const source = readFileSync(swPath, "utf8");
const manifest = extractPrecacheManifest(source);
const missing = [];

for (const entry of manifest) {
  if (!entry || typeof entry.url !== "string") fail("Precache manifest contains an entry without a string url.");
  const file = fileForPrecacheUrl(entry.url);
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    missing.push(`${entry.url} -> ${file ? relative(process.cwd(), file) : "invalid path"}`);
  }
}

if (missing.length) {
  fail([
    "Generated precache manifest contains URLs that do not exist in dist.",
    "Cloudflare's SPA fallback would mask these as index.html in production:",
    ...missing.map((item) => `- ${item}`),
  ].join("\n"));
}

console.log(`Precache verified: ${manifest.length} generated URLs exist in dist.`);

function extractPrecacheManifest(sourceText) {
  const marker = "const PRECACHE_MANIFEST = ";
  const start = sourceText.indexOf(marker);
  if (start === -1) fail("Could not find PRECACHE_MANIFEST in generated dist/sw.js.");
  const arrayStart = sourceText.indexOf("[", start + marker.length);
  if (arrayStart === -1) fail("Could not find precache array in generated dist/sw.js.");
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = arrayStart; i < sourceText.length; i += 1) {
    const char = sourceText[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        const literal = sourceText.slice(arrayStart, i + 1);
        try {
          const parsed = Function(`"use strict"; return (${literal});`)();
          if (!Array.isArray(parsed)) fail("PRECACHE_MANIFEST did not evaluate to an array.");
          return parsed;
        } catch (error) {
          fail(`Could not parse PRECACHE_MANIFEST: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  fail("Could not find the end of the PRECACHE_MANIFEST array.");
}

function fileForPrecacheUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl, "https://twochairs.club/");
  } catch {
    return null;
  }
  if (url.origin !== "https://twochairs.club") return null;
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/" || pathname.endsWith("/")) pathname = `${pathname}index.html`;
  if (pathname.startsWith("/")) pathname = pathname.slice(1);
  const candidate = normalize(join(distDir, pathname));
  const rel = relative(distDir, candidate);
  if (rel.startsWith("..") || rel === ".." || rel.split(sep).includes("..")) return null;
  return candidate;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
