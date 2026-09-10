# chess-with-friends

Two Chairs is a personal chess app for friends. The React/Vite client is in `src/main.tsx` and `src/styles.css`; Cloudflare Durable Objects in `src/worker.ts` own authoritative games, clocks, and move history.

Quick replay is local presentation state in `src/opponentReplay.ts`. It finds the latest move by the opponent's user ID and reconstructs it from the preceding saved FEN (the standard start for move one). Its icon button belongs inside the existing opponent bar, between the player controls and clock; do not add a separate row. It stays disabled until that opponent has moved. Replay never writes game state, pauses clocks, or sends a move; board input is disabled for its 850ms lifetime. A new live position, terminal status, hidden tab, or unmount cancels it. Castling replays both pieces; captures, en passant, and promotion use chess.js before/after positions. Reduced motion removes piece travel.

`npm run typecheck` and `npm run build` check source and the PWA precache. `npm run test:e2e -- --project=replay-desktop-chromium --project=replay-mobile-chromium --project=replay-desktop-webkit --project=replay-mobile-webkit` exercises quick replay. The existing mechanics and adversity projects cover integrated gameplay; run those for changes to the shared board/game screen. Browser evidence belongs in gitignored `tmp/`.

Replay fixtures freeze the browser clock before navigation and timestamp game
updates from that clock. Keep those together: pausing at the runner's current
time can race backward, and jumping a live clock can expire socket heartbeats.
Replay and orientation fixtures block service workers so caching cannot bypass
their mocked network routes. They use Vite preview on `PLAYWRIGHT_FIXTURE_PORT`
(default: `PLAYWRIGHT_PORT + 1`) to serve the production build. Short-lived fixture
pages repeatedly triggered Wrangler 4.118's fatal `Network connection lost`
proxy error; these fully mocked tests do not need the Worker proxy. Mechanics,
adversity and notifications still run against the real local Worker. The existing
PWA update fixture keeps service workers enabled. Playwright owns both app servers;
the Worker server builds the app before the fixture preview starts.
The single Playwright worker keeps integration tests sequential. Use default
test mode so a failed case reports a failure without suppressing later independent
cases; each test creates its own clients and uniquely named accounts.

The `wt` bootstrap runs `npm ci` and writes a stable per-worktree `PLAYWRIGHT_PORT` to ignored `.worktree-env`; `npm run test:e2e` sources it unless the caller supplies a port. Playwright owns its local Wrangler server and uses `.wrangler/state-<port>` for isolated test storage. No credentials or local state are copied by the bootstrap. `npm run typecheck` is the smallest fresh-worktree check. Use explicit ports when manually running simultaneous dev servers.

The notification lifecycle test runs in Chromium and WebKit. WebKit obtains its
real test-account session from a separate Chromium virtual authenticator and
copies only session cookies; its own notification storage survives sign-out and
reauthentication. Keep permission, subscription, sign-out and rebinding assertions
in the target engine. CDP setup does not establish WebKit passkey support.

AppDO owns one shared database snapshot. Its requests, alarms, and background
push write-backs enter `withState` so asynchronous work cannot save stale state
over a newer mutation. Push network delivery runs outside the queue; its final
write reloads current state inside it. Call `runAlarm` directly from an already
queued handler such as the local debug tick, never enqueue recursively. GameDO
initialization does not call back into AppDO; preserve that when awaiting it from
a queued handler. `npm run test:state` exercises suspended requests, concurrent
challenge/push writes, alarm persistence, consume-once reads, and error recovery
against the real AppDO class with an isolated storage host. Real Worker mechanics
and adversity tests remain the integration gate.

GameScreen accepts snapshots from HTTP and the socket through `receiveGame`.
Move history is append-only: an HTTP resync arriving after a newer socket move
must not rewind the board. The replay suite holds an old HTTP response to exercise
that ordering deterministically. Mock voice tests explicitly advance ICE state
after checking the connecting UI; the separate real-peer test covers actual ICE.

The realtime hook's current socket exclusively owns its callbacks and timers.
The liveness check replaces non-open sockets without waiting for a close handshake;
late events from retired sockets cannot cancel or alter the replacement. Keep the
stalled-close regression alongside the replay fixtures, and exercise real Worker
socket recovery and voice lifecycle tests when changing this ownership.

## Portrait-only mobile use

`public/manifest.webmanifest` requests portrait orientation. Keep VitePWA's
`manifest: false` so its generated defaults cannot overwrite that file in builds.
`src/PortraitOnly.tsx`
also attempts the browser lock and blocks touch-device landscape interaction with
a rotate-to-portrait notice when the browser refuses it. Keep the app mounted
behind the notice so form input, game state, and live connections survive rotation.
Detect screen orientation, not viewport aspect ratio: opening a software keyboard
can make a portrait viewport wider than it is tall. Desktop windows stay usable.
Run `npm run test:e2e -- --project=orientation-chromium --project=orientation-webkit`
for the focused device-orientation coverage (WebKit on Linux).
