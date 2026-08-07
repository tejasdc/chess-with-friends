import { readFileSync } from "node:fs";

const worker = readFileSync("src/worker.ts", "utf8");
const match = worker.match(/const PUSH_TYPES[^=]*=\s*\[([^\]]+)\]/);
if (!match) {
  console.error("Could not find PUSH_TYPES in src/worker.ts");
  process.exit(1);
}

const pushTypes = [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
const testFiles = ["tests/e2e.spec.ts", "tests/adversity.spec.ts"];
const testText = testFiles.map((file) => readFileSync(file, "utf8")).join("\n");
const missing = pushTypes.filter((type) => !new RegExp(`copy-contract:\\s*${type}\\b`).test(testText));

if (missing.length > 0) {
  console.error(`Missing push copy assertion marker(s): ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`Push copy contract verified for: ${pushTypes.join(", ")}.`);
