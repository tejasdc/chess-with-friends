import { readFileSync } from "node:fs";

const allowed = ["friend_request", "challenge", "scheduled_start"];
const files = ["src/worker.ts", "public/sw.js"];
const found = new Set();
const violations = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/["']([a-z_]+)["']/g)) {
    const value = match[1];
    if (allowed.includes(value)) found.add(value);
    if (value.includes("push") || value.includes("notification")) continue;
    if (/(online|streak|daily|rating|presence|reminder|nudge|comeback)/.test(value)) {
      violations.push(`${file}: suspicious notification-like literal "${value}"`);
    }
  }

  const pushCalls = [...text.matchAll(/enqueuePush\([^,]+,[^,]+,\s*["']([^"']+)["']/g)].map((match) => match[1]);
  for (const type of pushCalls) {
    if (!allowed.includes(type)) violations.push(`${file}: enqueuePush uses disallowed type "${type}"`);
  }
}

for (const type of allowed) {
  if (!found.has(type)) violations.push(`missing allowed push type "${type}"`);
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log(`Push policy verified: ${allowed.join(", ")} only.`);
