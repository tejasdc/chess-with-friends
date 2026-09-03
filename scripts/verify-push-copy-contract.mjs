import { readFileSync } from "node:fs";

const sourceFiles = ["src/worker.ts", "src/d1-app.ts"];
const typeSets = sourceFiles.map((file) => {
  const source = readFileSync(file, "utf8");
  const match = source.match(/const PUSH_TYPES[^=]*=\s*\[([^\]]+)\]/);
  if (!match) {
    console.error(`Could not find PUSH_TYPES in ${file}`);
    process.exit(1);
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
});
const pushTypes = typeSets[0];
for (let index = 1; index < typeSets.length; index += 1) {
  if (JSON.stringify(typeSets[index]) !== JSON.stringify(pushTypes)) {
    console.error(`${sourceFiles[index]} PUSH_TYPES differs from ${sourceFiles[0]}`);
    process.exit(1);
  }
}
const testFiles = ["tests/e2e.spec.ts", "tests/adversity.spec.ts"];
const testText = testFiles.map((file) => readFileSync(file, "utf8")).join("\n");
const missing = pushTypes.filter((type) => !new RegExp(`copy-contract:\\s*${type}\\b`).test(testText));

if (missing.length > 0) {
  console.error(`Missing push copy assertion marker(s): ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`Push copy contract verified for: ${pushTypes.join(", ")}.`);
