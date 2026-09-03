import { readFileSync } from "node:fs";

// Present set. The notification policy in docs/requirements.md is a
// PRINCIPLE, not a locked count — see there. This script only asserts:
// (a) every enqueuePush uses a type on this list, and (b) nothing
// notification-like slipped in that names re-engagement categories
// (presence, streak, nudge, etc.). Adding to this list means the new
// push satisfies the principle (serves the user's own intention).
const allowed = ["friend_request", "challenge", "challenge_accepted", "scheduled_start", "call_invite"];
const files = ["src/worker.ts", "src/d1-app.ts", "src/sw.js"];
const found = new Set();
const violations = [];
const main = readFileSync("src/main.tsx", "utf8");

if (/subscription\.unsubscribe\s*\(/.test(main)) {
  violations.push("src/main.tsx: automatic browser PushSubscription.unsubscribe() is forbidden; logout must preserve OS/browser notification permission.");
}

const signOutMatch = main.match(/async function signOut[\s\S]*?\n}\n/);
if (signOutMatch && /\/api\/push\/unsubscribe|endpoint/.test(signOutMatch[0])) {
  violations.push("src/main.tsx: signOut must not detach or unsubscribe push endpoints.");
}

for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/["']([a-z_]+)["']/g)) {
    const value = match[1];
    if (allowed.includes(value)) found.add(value);
    if (value.includes("push") || value.includes("notification")) continue;
    // Look for re-engagement CATEGORY names — words that name what the
    // banned pushes would BE, not neutral tokens that share letters.
    // "daily" alone is fine (recurrence kind); "daily_reminder" is not.
    if (/(streak|comeback|nudge|reengagement|reengage|reminder|activity_ping|inactive)/i.test(value)) {
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
