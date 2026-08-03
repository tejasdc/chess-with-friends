# Chess with Friends — Duchamp round report

**Round completed:** 2026-08-03
**Deployed:** https://chess.tejas.nyc (Worker version `20e6de96-4c47-4cd2-b40d-da3ff3609799`)
**Commits:** `f457e7f` (bug fixes + one-press auth) → `fca076a` (Duchamp design + 3D landing)

## Reference study — Marcel Duchamp, "Pocket Chess Set", 1943

The object is a bifold black leather wallet, ~16 × 10.5cm closed / ~16 × 22cm opened. The interior board's squares are HAND-PAINTED (not printed) on warm-tan leather — visible brushwork, imperfect edges, saturated honey light squares and deep coffee-brown dark squares. Pieces are custom Duchamp silhouettes PRINTED on celluloid discs (translucent early plastic, cream tone) with dark-ink emblems, each with a small hole. A brass pin head on each board square pushes through the hole and holds the piece during transport. Design ethos: readymade sensibility — a manufactured object curated + modified by the artist; function-first; a work of art that is also entirely playable, not a display piece. Approximately 25 fully assembled sets were made in New York in 1943-44. Holdings: Philadelphia Museum of Art, Yale University Art Gallery, Art Institute of Chicago, Duchamp Research Portal.

Sources referenced during research:
- [Philadelphia Museum of Art record](https://www.philamuseum.org/objects/51703)
- [Art Institute of Chicago record](https://www.artic.edu/artworks/210442/pocket-chess-set)
- [Yale University Art Gallery record](https://artgallery.yale.edu/collections/objects/34120)
- [tout-fait scholarship](https://www.toutfait.com/unmaking_the_museum/Pocket%20Chess%20Set.html)

## Direction exploration

Three directions were considered from the reference:

- **A — "Open Wallet" (SHIPPED)**. The app IS the interior of the opened wallet. Warm honey-tan is the app ground; deep leather chrome frames it. Interactive tiles are cream celluloid pinned to the ground by brass pin heads on their leading edge. Board palette from the actual painted interior. Serif italic wordmark, mono caps for manufacturer's-mark labels. The design vocabulary carries the object's language literally into every screen without narrating anything.

- **B — "Set on Table" (runner-up)**. The app sits on a muted warm-paper table, wallet-as-object with a slight overhead perspective, chrome outside the wallet is table not leather. Beautiful but requires more layout gymnastics to consistently render the wallet-object as-a-thing across every screen, and creates dead space around it.

- **C — "Closed Wallet" (runner-up)**. Dark leather everywhere (like the wallet's exterior), the board as the only lit element. Moodier, more evening/candlelit. Reserved as fallback if Tejas prefers a chrome-heavy world; would flip the palette dominance from warm interior to dark exterior.

If Tejas wants direction B or C instead, the token swap in `src/styles.css` is the change point — the primitives (pin heads, celluloid tiles, section titles, mono caps) all carry.

## What shipped

### 1. Duchamp design language — every screen

- **Palette (locked)**: `--leather-deep #1e150c`, `--leather #2c1e12`, `--leather-warm #4a3220`, `--honey #d8b477`, `--coffee #3e2a17`, `--celluloid #f2e9cc`, `--ink #1a120a`, `--brass #b58a3c`, `--vermillion #a63a23` (destructive only).
- **Typography**: Iowan Old Style italic for wordmark + section titles; system sans for body; mono caps (uppercase, 0.04em tracking) for all field labels and status marks. No Inter.
- **Primitives**: brass pin-head marks anchor primary interactive tiles (topbar, install strip, invite panel, incoming rows, primary CTAs, tab underline). Celluloid tiles for interactive surfaces. Hand-painted radial highlights on board squares. Section titles are italic serif with a hairline separator — no bordered boxes.
- **Screens reskinned**: auth, dashboard, install prompt, invite panel, incoming rows, games list, play/schedule tabs + form, friends section, game screen with the walnut/leather board frame and honey/coffee squares. Nothing is left over from the previous palette.

### 2. 3D landing scene — real WebGL, lazy-loaded

`src/WalletScene.tsx` — a three.js scene of the opened bifold Duchamp wallet laid flat. Grabbable: drag the wallet to orbit ±20°, release and it eases back to a slow idle sway. Left flap holds the hand-painted board with pieces mid-game (K, Q, R, B, N, P — abstract emblem primitives, not literal Staunton, echoing Duchamp's custom silhouettes on celluloid). Right flap has a brass-pin rack. Warm three-point lighting (key + brass rim + fill). Every geometry, material, and event listener is disposed on unmount.

Bundle discipline: `import("./WalletScene")` via `React.lazy`. Main bundle stays at 82KB gzipped for authenticated users; WalletScene chunk is 137KB gzipped and only lands on unauthenticated first-paint. No external assets.

### 3. One-press auth

New flow: on Handle input, a 350ms debounce silently probes `/api/auth/login/options` to determine whether an account exists. By the time the user clicks Continue, the button already knows to run login or register — a single WebAuthn prompt fires from a single user activation. If the probe hasn't landed yet, `submit()` runs the same probe inline before the credential call. No second click, ever.

### 4. Bug fixes

- **Sign out** actually returns to the auth screen now. `signOut()` was pushState-only; App's `home` state was untouched so the dashboard kept rendering. Fix: `signOut` takes an `onSignedOut` callback that App wires to `() => setHome(null)`. New e2e coverage: `sign out returns to the auth screen`.
- **Install-to-Home-Screen guidance** shows independently of push support. Old panel returned `null` when `pushStatus === "unsupported"` — which is exactly the case in Safari private browsing where the user most needs install instructions. Split the concerns: install guidance shows whenever `display-mode: standalone` is false (works via `matchMedia` + iOS `navigator.standalone`); notification button shows only when push is supported and ready. New e2e coverage: `install guidance shows even when push is unsupported` (stubs `PushManager` as undefined).

## Verification

- `npm run typecheck` — clean
- `npm run build` — clean; main `82KB gzip`, WalletScene chunk `137KB gzip`, CSS `4.25KB gzip`
- `npm run test:e2e` (chromium project, 5 tests):
  - notification prompt gone after enable + reload
  - auth board holds a stable size at mobile viewport under scroll
  - sign out returns to the auth screen
  - install guidance shows even when push is unsupported
  - two simulated clients exercise v1 mechanics end-to-end
  - **all 5 green**
- Prod: `curl -s https://chess.tejas.nyc/api/health` returns ok; `cloudflareinsights` beacon count = 1; asset hashes `index-BzwiEm02.js`, `index-D3M7_uT8.css` served after cache flush.

WebKit note: Playwright's WebKit binary still segfaults on this Darwin 25 pre-release build (upstream). The `mobile-webkit` project remains configured for any released macOS or CI environment; the invariant fix from the previous round is preserved and this round's regression test now targets `.auth-scene`, which sits in the identical grid ancestor chain.

## Screenshot inventory (`tmp/reviews/screens-claude/`)

- Auth: `desktop-auth-empty.png`, `mobile-auth-empty.png`, `mobile-auth-typed.png` — 3D wallet visible with pieces, brass rack on right flap, one-press form on the right
- Dashboard: `desktop-dashboard-with-friend.png`, `mobile-dashboard-with-friend.png` — install strip with pin head, italic Play / Friends titles, celluloid form tiles, tab underline with brass
- Game: `desktop-game-mid.png`, `mobile-game.png` — walnut leather frame, honey/coffee hand-painted board, cream celluloid pieces mid-game
- Auxiliary: `desktop-play-schedule-tab.png`, `desktop-incoming-friend.png`, `desktop-friend-request-sent.png`

## Human eyes needed

- **Real iPhone Safari** — Playwright's WebKit is broken locally so the 3D scene has NOT been verified on real iOS Safari. three.js works on iOS 14+ Safari with WebGL by default; the scene should render but Tejas please confirm on his phone (both in Safari and installed as PWA) that (a) the wallet renders, (b) touch drag orbits it, (c) it doesn't stutter or eat battery. If it stutters on an older iPhone, easy fallbacks are: reduce piece count, disable the fill light, or degrade to a static image below a device-memory threshold.
- **Direction check**. If Tejas prefers B (Set on Table) or C (Closed Wallet), the palette-token change point is `src/styles.css:1-70`.
- **Piece emblems in the 3D scene are abstract** (cross for K, crown for Q, miter for B, angled quad for N, disc for P). This mirrors Duchamp's own custom-silhouette approach. If Tejas wants standard Staunton silhouettes in 3D instead, that's a swap in `buildEmblem()`.

## Runbook if the deploy needs to roll back

- `wrangler rollback` to the prior version.
- OR revert commit `fca076a` (Duchamp language) and re-deploy — `f457e7f` (bug fixes) is safe to keep independent of the design work.
