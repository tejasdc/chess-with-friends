# Chess with Friends — realtime + adversity + niceties round

**Deployed:** https://chess.tejas.nyc (Worker version `6c24f8d5-6a1d-4a75-81b4-0bc59c775628`)
**Commits:** `b9b978d` (resilient realtime + fetch credentials) → `534114f` (adversity harness + humane presence) → `5d5e803` (board niceties)

## What was blocking Tejas

- "Lag is incredibly bad… we cannot play like this." — root cause: GameScreen opened ONE WebSocket with zero recovery. iOS Safari kills sockets constantly (URL bar transitions, lock, tab switch); the dead socket never reconnected, the board silently froze, updates only arrived on manual refresh.
- Game-screen infinite spinner when opening an old pre-rebuild game — `load()` had no `catch`, any failure sat forever at "Opening board…".
- Sign out did nothing (fixed earlier round; belt-and-suspenders session-cookie hardening added this round).
- Silent auto-queen on promotion (server-side hardcoded `promotion: "q"` in the client).

## What shipped

### 1. Resilient realtime — the failure mode is gone

`useRealtimeGame(gameId, { onGame, onResync, enabled })` in `src/main.tsx`:
- Reconnects on close/error with exponential backoff (250ms → 500 → 1000 → 2000, capped 5000).
- Every open: sends `"sync"` AND fires an `onResync()` REST snapshot as belt-and-suspenders in case a server broadcast fired between the last disconnect and this reconnect.
- `visibilitychange` handler: when the tab becomes visible and the socket isn't `OPEN`, closes any pending attempt and reconnects immediately (no backoff). If already `OPEN`, fires a sync so the just-woken UI is current.
- Heartbeat: client sends `"ping"` every 15s; server replies `"pong"` (cheap, no full-state rebroadcast). Client tracks `lastInboundAt`.
- Liveness: if no inbound frame for 25s during an active game, the socket is treated as half-open; client closes it, `close` fires, `scheduleReconnect` kicks in.
- Full cleanup on unmount + effect re-run.

Server side (`src/worker.ts`):
- WS message handler differentiates `ping` (reply `pong` only) from any other message (still triggers full `send(state)`).
- Reconnect grace extended from 3s to 15s before promoting a disconnected player to the harshest state — iOS routinely takes 5-10s to reconnect after URL-bar transitions.

Presence UX (Tejas's ask — "bare gone reads insane"):
- Rendered via `presenceLabel()`: connected → `here`, reconnecting → `away`, gone → `offline`. Handle stays adjacent so the state is attributed to a person. Semantic state class names unchanged.

### 2. Game-screen spinner + tolerant load

`GameScreen.load()` now catches. Failure sets `loadError` and renders a celluloid tile with Try again + Home buttons in the Duchamp language. Retry via a `loadAttempt` counter that re-runs the load effect. No server-side change needed — the client just needed to survive failures.

### 3. Session cookie hardening

`api()` fetch now passes `credentials: "same-origin"` explicitly. Modern browsers default to this, but service-worker fetch interception has surprised us in Safari — being explicit guarantees the session cookie rides every `/api` call regardless of what the SW does. Server cookie attributes (`HttpOnly`, `SameSite=Lax`, `Max-Age=30d`, `Secure`) are already correct.

### 4. Adversity test harness

New `adversity` Playwright project (`tests/adversity.spec.ts`) — hostile-conditions suite that runs alongside mechanics. A round is not shippable unless this project is green.

Scenarios (all use a `WebSocket` wrapper installed at page-init time so tests can reach into the socket bag):
1. Socket death mid-game — force-close bob's WebSocket, verify alice's next move materializes on bob's board within 15s (no refresh).
2. Visibility + socket death — close bob's socket AND flip visibility to `hidden` (iOS backgrounded state), have alice move, bring bob back to visible — the visibility handler must reconnect + resync within 10s.
3. Network dropout via CDP — `Network.emulateNetworkConditions(offline)`, alice moves, restore network, bob catches up within 20s.
4. Rapid duplicate input — two clicks on the target square — move lands exactly once, no phantom moves.
5. Perf floor — CPU throttled 4x, alice-to-bob roundtrip stays under 2000ms.

`playwright.config.ts` now defines three projects: `chromium` (mechanics), `adversity` (harness), `mobile-webkit` (layout regression). `testMatch` scopes each.

### 5. Board niceties in the Duchamp language

- Legal-move dots. Tap a piece → every legal destination gets a brass pin-head dot; captures get a brass ring inset in the target square (pin-through-hole vocabulary). `chess.js.moves({verbose:true})` drives it so promotion, castling, en passant are all included natively.
- Real promotion picker. Detected locally: a pawn moving to rank 8/1 that chess.js says can promote pauses the move and shows a small celluloid strip with Q/R/B/N tiles. `submitMove()` is now the single write path for both plain and promotion moves.
- Last-move highlight. From-square light brass wash, to-square stronger brass wash.
- In-check indication. King's square gets a vermillion inset border + soft interior glow when the side to move is in check.
- Captured-material strip. Thin strip above the opponent clock (what they captured from you) and below yours (what you captured). Sorted by piece value. Rebuilt by replaying SAN moves — no server change.
- Tap-selected-square-again cancels selection.

Deferred (bolt-on-able):
- Move/capture sounds with mute-respecting choreography
- Drag alongside tap
- Move-list scrubbing (adds review-vs-live state distinction — its own design pass)

## Verification

- `npm run typecheck` — clean
- `npm run build` — clean; main `82KB gzip`, WalletScene chunk `137KB gzip`, CSS `4.4KB gzip`
- `npm run test:e2e` runs `chromium` + `adversity` → 10/10 green (5 mechanics + 5 adversity)
- Prod: `/api/health` ok; CF Insights beacon count = 1; new asset hashes `index-CgDwNxqF.js`, `index-4824Lhov.css` served after cache flush.

WebKit note: Playwright's WebKit binary still segfaults on this Darwin 25 pre-release. The `mobile-webkit` project runs on any released macOS or CI.

## Screenshot inventory (`tmp/reviews/screens-claude/`)

- `desktop-game-mid.png` — Duchamp world, presence label "HERE", last-move highlight on Nf3.
- `desktop-game-legal-moves.png` — bob's g8 knight selected, brass pin-head dots on f6 and h6.
- `mobile-game.png` — full board on 390px viewport.

## Human eyes still needed

- Real iPhone Safari — Tejas please replay the "lag" case: open a game, lock the screen, unlock, tab-switch, return. Board should hold sync throughout with no manual refresh; presence label should read `here` → `away` briefly → `here` through a lock/unlock, not the previous `gone` cascade.
- Sounds / drag / move-list scrub — three deferred niceties. Name any must-have and I'll pick them up.
- 3D landing scene should still render — no `WalletScene.tsx` changes this round.

## Runbook if the deploy needs to roll back

- `wrangler rollback` to the prior version.
- OR revert commits `b9b978d`, `534114f`, `5d5e803` in that order (Duchamp design language commit `fca076a` is independent and stays).
