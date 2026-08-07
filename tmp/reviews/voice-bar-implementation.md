# Voice Bar Implementation

## Commits

- `Redesign voice call bar` — folds all voice-call states into the opponent player-bar slot, replaces lucide with Phosphor icons, removes below-bar status strips and peer-muted UI, and updates tests/visual matrix/docs.

## Files Touched

- `docs/state-machines.md`: +60 / -97
- `package-lock.json`: +14 / -10
- `package.json`: +1 / -1
- `scripts/visual-matrix.mjs`: +27 / -18
- `src/main.tsx`: +88 / -126
- `src/styles.css`: +89 / -96
- `tests/adversity.spec.ts`: +80 / -12

## Icon Set

Chose Phosphor Icons (`@phosphor-icons/react`) after comparing:

- Phosphor: flexible React package with multiple weights and a warmer, receiver-shaped phone vocabulary that fits this app's geometric-but-human visual identity. Source: https://github.com/phosphor-icons/react and https://phosphoricons.com/
- Iconoir: strong candidate for the hand-drawn single-stroke feel, with a broad React package on a 24x24 grid. Source: https://iconoir.com/docs/packages/iconoir-react
- Radix Icons: crisp and geometric, but the 15x15 system set is more UI-toolkit neutral and does not have the same complete phone/mic vocabulary. Source: https://www.radix-ui.com/icons

Imported icons:

- `Phone` for idle/requesting/connecting/reconnecting/ended.
- `Microphone` for connected unmuted.
- `MicrophoneSlash` for connected muted.
- `PhoneDisconnect` for hangup.

## Red-Green Log

- New regression test: `voice call slot stays in opponent bar and changes icon by state`.
- Red: temporarily removed the opponent-bar `<VoiceCallSlot />` render, then ran `PLAYWRIGHT_PORT=8790 npx playwright test --project=adversity tests/adversity.spec.ts -g "voice call slot stays in opponent bar and changes icon by state"`. It failed on the missing `.clock-strip.top [data-voice-call-slot='opponent']` selector.
- Green: restored the slot and reran the same command on `PLAYWRIGHT_PORT=8790`; it passed.

Additional assertions added:

- Slot must live inside the opponent row and must not exist in the self row.
- `.voice-status`, `.voice-ending`, and `.peer-muted-pill` remain absent.
- Icon state changes across idle, requesting, connecting, connected, muted, and ended states via explicit `data-call-icon` / `data-call-control-state` assertions.

## Screenshots

Captured through the visual matrix at `390x844`:

- Idle: `tmp/visual-matrix/390x844/game-call-idle.png`
- Requesting, caller view: `tmp/visual-matrix/390x844/game-call-requesting-caller.png`
- Requesting, recipient view: `tmp/visual-matrix/390x844/game-call-requesting-recipient.png`
- Connecting: `tmp/visual-matrix/390x844/game-call-connecting.png`
- Connected: `tmp/visual-matrix/390x844/game-call-connected.png`
- Muted: `tmp/visual-matrix/390x844/game-call-connected-muted.png`
- Ended recent: `tmp/visual-matrix/390x844/game-call-ended-recent.png`
- Contact sheet: `tmp/visual-matrix/390x844/contact-sheet.html`

## Verification

- `npm run typecheck` passed.
- Focused red-green test passed after restoration.
- Voice adversity tests passed individually after rewrite.
- Visual matrix voice cells passed with zero overlap findings:
  `VISUAL_MATRIX_VIEWPORTS=390x844 VISUAL_MATRIX_CELLS=game-call-idle,game-call-requesting-caller,game-call-requesting-recipient,game-call-connecting,game-call-connected,game-call-connected-muted,game-call-ended-recent node scripts/visual-matrix.mjs`
- Full best-effort E2E passed: `PLAYWRIGHT_PORT=8804 npm run test:e2e` completed 56/56.

## Follow-Up

- The server-side `callSession.muted` broadcast can be removed later only after confirming no non-UI clients, debug tools, or downstream tests rely on it. The web client no longer reads or renders `session.muted[opponentId]`; it still sends local mute updates for protocol compatibility.
- I left unrelated PWA update-detection and disconnection work in the working tree unstaged.
