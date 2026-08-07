# PWA update handling implementation summary

## Commits made

- `b3c911e` — Add gated PWA update handling.

## Files touched and line counts

From `git show --numstat b3c911e`:

- `package-lock.json`: +5978 / -1654
- `package.json`: +5 / -2
- `playwright.config.ts`: +5 / -0
- `scripts/verify-precache.mjs`: +94 / -0
- `scripts/verify-push-policy.mjs`: +1 / -1
- `src/activeGameStore.ts`: +19 / -0
- `src/main.tsx`: +8 / -1
- `src/pwaUpdateHandling.tsx`: +124 / -0
- `{public => src}/sw.js`: +20 / -11
- `src/vite-env.d.ts`: +2 / -0
- `tests/e2e.spec.ts`: +131 / -1
- `tests/pwa-update.spec.ts`: +150 / -0
- `vite.config.ts`: +18 / -1

## Red-green log

- `scripts/verify-precache.mjs`
  - Red: injected a bogus `missing-from-dist.js` entry into generated `dist/sw.js`; `node scripts/verify-precache.mjs` failed with `Generated precache manifest contains URLs that do not exist in dist`.
  - Green: `npm run build` regenerated `dist/sw.js` and postbuild passed: `Precache verified: 10 generated URLs exist in dist.`

- `tests/e2e.spec.ts` SW lifecycle harness
  - Red condition covered: the previous handwritten SW had no injected manifest and called `skipWaiting()` during install, so the new assertions for manifest precaching and gated skip-waiting would fail against that shape.
  - Green: `npx playwright test tests/e2e.spec.ts -g "service worker" --project=chromium` passed 3/3, including `service worker precaches injected manifest and waits for gated skipWaiting message`.

- `tests/pwa-update.spec.ts`
  - Red during implementation: initial fixture did not serve SW-v2 to the browser's service-worker update request, producing `unsupported MIME type ('text/html')`; after switching to a real local fixture server, the test exposed a reload-navigation race, then passed after waiting for navigation.
  - Green: `npx playwright test tests/pwa-update.spec.ts --project=pwa` passed 1/1.

## Build wiring confirmation

`package.json` now has `postbuild: node scripts/verify-precache.mjs`. Because `deploy` runs `npm run build && wrangler deploy`, a deploy cannot proceed through the normal script path if the generated precache manifest contains a URL missing from `dist`.

## Guard-rail grep confirmation

`git grep -n "autoUpdate\\|skipWaiting()" -- . ':!node_modules' ':!dist'` shows:

- `vite.config.ts:8` has the guard comment explaining why `autoUpdate` must not be used.
- `src/sw.js:11` has the guard comment explaining why install must not call `skipWaiting()`.
- `src/sw.js:20` is the gated `{ type: "SKIP_WAITING" }` handler.
- Remaining matches are test harness/fixture `skipWaiting()` calls.

## Validation

- `npm run typecheck`: passed.
- `npm run build`: passed, including postbuild precache verification.
- `npm run test:push`: passed.
- `npx playwright test tests/e2e.spec.ts -g "service worker" --project=chromium`: passed.
- `npx playwright test tests/pwa-update.spec.ts --project=pwa`: passed.
- Best-effort `npm run test:e2e`: chromium passed through the full existing project and the PWA project passed; the run failed in unrelated in-flight adversity work at `tests/adversity.spec.ts:715` (`voice hangup clears muted projections on ended snapshots`) with `Cannot read properties of undefined (reading 'id')`, then skipped the remaining serial adversity tests.

## Follow-up

- The full-suite adversity failure is outside this PWA change and sits in the disconnection/voice area Tejas explicitly asked not to chase in this pass.
- The worktree still contains unrelated unstaged changes and untracked review/design artifacts that were left untouched.
