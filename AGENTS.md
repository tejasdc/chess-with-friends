# chess-with-friends

Two Chairs is a personal chess app for friends. The React/Vite client is in `src/main.tsx` and `src/styles.css`; Cloudflare Durable Objects in `src/worker.ts` own authoritative games, clocks, and move history.

Quick replay is local presentation state in `src/opponentReplay.ts`. It finds the latest move by the opponent's user ID and reconstructs it from the preceding saved FEN (the standard start for move one). The button above the opponent bar stays disabled until that opponent has moved. Replay never writes game state, pauses clocks, or sends a move; board input is disabled for its 850ms lifetime. A new live position, terminal status, hidden tab, or unmount cancels it. Castling replays both pieces; captures, en passant, and promotion use chess.js before/after positions. Reduced motion removes piece travel.

`npm run typecheck` and `npm run build` check source and the PWA precache. `npm run test:e2e -- --project=replay-desktop-chromium --project=replay-mobile-chromium --project=replay-desktop-webkit --project=replay-mobile-webkit` exercises quick replay. The existing mechanics and adversity projects cover integrated gameplay; run those for changes to the shared board/game screen. Browser evidence belongs in gitignored `tmp/`.

The `wt` bootstrap runs `npm ci` and writes a stable per-worktree `PLAYWRIGHT_PORT` to ignored `.worktree-env`; `npm run test:e2e` sources it unless the caller supplies a port. Playwright owns its local Wrangler server and uses `.wrangler/state-<port>` for isolated test storage. No credentials or local state are copied by the bootstrap. `npm run typecheck` is the smallest fresh-worktree check. Use explicit ports when manually running simultaneous dev servers.
