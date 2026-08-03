# two chairs — REQUIREMENTS LEDGER (Tejas-stated, verbatim-spirit)

Every item below was explicitly ordered by Tejas. Before ANY major deploy — and
especially the landing production build — every item must be VERIFIED and reported
with evidence (screenshot / probe / test name). A regression on any item is a
shipping blocker. Maintained by the team lead; agents propose additions when Tejas
issues new orders.

## World / design tokens
- [ ] Palette is the MOCKUP tokens exactly: celadon #7CA898 ground, teal-dark
      #5F8A7A + buff #E8DBBE board, navy #2E2A3D (buttons FILLED navy), cream
      #EEE3C4, teak #8C5A2E. No yellow-khaki anywhere. No legacy tokens.
- [ ] Teak frame around the board at ALL sizes — a visible frame, never a hairline.
- [ ] IBM Plex Mono voice. No serif poems. NO thesis-narrating copy anywhere in UI.
- [ ] No scrolling anywhere scrolling isn't needed (landing, game, inspirations
      no-scroll; dashboard may scroll only when content demands).
- [ ] Fixes apply to the PATTERN everywhere — never only the reported page.
- [ ] "made by tejas.nyc" on landing + dashboard + inspirations ONLY (never game),
      pinned to bottom on every page that has it; landing footer also carries the
      inspirations link.
- [ ] No ⋯ menu on the landing. ⋯ top-right on dashboard + game; menu holds
      sign out, install/notification state, invite link, inspirations.
- [ ] Name is "two chairs" (lowercase): wordmark, <title>, manifest name/short_name,
      APP_NAME var (passkey rpName).
- [ ] Icon: Rodchenko elevation TRACE in app tokens (map A: cream/teak/navy),
      bent-tube arc CONNECTED (continuous stroke), verified at zoom.

## Board & game screen
- [ ] Board dominant: near-full-width at 390; prototype-scale on desktop; game
      screen NEVER scrolls (verified 390×844, 1280×700, 1440×900 — regression test).
- [ ] Thick cream border = SELECTION ONLY, scales with square size, never overlaps
      piece glyphs.
- [ ] Last-move = flat tint wash on from+to squares. NO border. Only one border
      vocabulary on the board (selection).
- [ ] Legal-move dots from chess.js. Opponent pieces untappable. Off-turn taps
      silent. Illegal-destination taps silent (deselect). ZERO toasts during
      gameplay; only genuine system failures may toast.
- [ ] Captured pieces BIG and bold; space reserved (no mid-game layout shift).
- [ ] Presence = filled dots both states, legible at arm's length, no words.
- [ ] Opponent connection state = in-game indicator, never a push.
- [ ] Promotion picker (never silent auto-queen). Check indication. Coordinates
      outside squares.
- [ ] Clocks/moves server-authoritative; resilient realtime (reconnect+backoff,
      visibilitychange resync, heartbeat, half-open detection).
- [ ] 10 minutes IS the game — no time-control UI anywhere.

## Dashboard
- [ ] Live/in-play games at TOP, prominent. Past games = separate collapsed section.
- [ ] Friends list IS the action surface: online first with Invite; offline rows
      signal by dot + disabled state; ~8 rows then "More friends" disclosure.
- [ ] ONE "Schedule a game" button at the BOTTOM of the friends section (no
      standalone schedule section, no per-friend schedule).
- [ ] Schedule = day + time picker (never "start in minutes"). Recurring:
      once / weekly / daily; accept ONCE; push each occurrence; End series from
      either side.
- [ ] Copy-invite-link lives in ⋯ menu only.
- [ ] Incoming challenge = prominent band with Accept.
- [ ] Human copy everywhere: "@x invited you to a game · 10 min". Pipe notation
      ("10|0") NEVER user-facing.

## Auth / landing
- [ ] One-line auth row: input + button same line, equal heights, shared border
      treatment, designed (non-slab) disabled state.
- [ ] Button "Sign in or sign up", morphing via debounce probe to "Sign in as @x" /
      "Sign up as @x" (reserved width, no layout jump).
- [ ] No "Passkeys only" footnote. No taken-handle subline. Raw platform error text
      NEVER surfaces. Error matrix verbatim: sign-up cancel → "Passkey wasn't
      created — try again."; sign-up platform error → "Couldn't create a passkey on
      this device."; sign-in failure → "That handle may be taken — try a different
      one."; server-provided messages pass through.
- [ ] iOS inputs ≥16px computed (no focus zoom).
- [ ] Landing: no scroll at 390, no menu, pinned footer "made by tejas.nyc ·
      inspirations".
- [ ] Landing content = puzzle shelf: REAL single-move puzzles ONLY (a position
      with a genuine solve-in-one; the bare starting position is NOT a puzzle),
      ~32 curated, each with credit + side-to-move caption ("WHITE TO MOVE ·
      RÉTI 1921"), ordered for transition density.
- [ ] Solving = tap-tap identical to game. Stuck-own-piece tap → small wobble ack.
- [ ] Transition = approved v5 grid walk: Manhattan square-by-square, ~360ms/square,
      staggered, straggler trays (nothing ever disappears), NO chaos/tumble physics.
- [ ] Landing copy ON the landing: "No infinite pool of opponents. A game happens
      when two friends sit down."
- [ ] Install prompt: dismissible ×, reason line (notifications), platform
      instructions; blocked state → delete-and-re-add recovery copy. Enable button
      carries "so you know when a friend invites you".

## Notifications
- [ ] Policy is the PRINCIPLE (serves the user's own intention; re-engagement
      banned permanently). Current set: friend_request, challenge,
      challenge_accepted, scheduled_start — descriptive, not a cap.
- [ ] Waiting room: sending an invite lands sender AT the board ("waiting for @x");
      accept transitions live in place; challenge_accepted push to inviter.

## Inspirations / attribution
- [ ] Fuller entries restored; museum/exhibition provenance lines REMOVED; the
      Workers' Club active-and-collective sentence present; Hartwig entry present;
      real attribution only (no self-references, no "photo by Tejas"; famous
      constructivist pieces are Lavrentyev/Vasnetsova 1976, NOT Rodchenko — say so
      if pieces are referenced).

## Infra
- [ ] twochairs.club canonical; chess.tejas.nyc serves duplicate (NO 301).
- [ ] Origin-aware analytics beacon (twochairs.club → its own token).
- [ ] HTML no-cache; hashed assets immutable (deploys reach phones on plain reload).
- [ ] Full test gate green: mechanics + adversity (+ webkit project where runnable).
- [ ] Every deploy verified live: health, beacon, asset hashes, and the specific
      feature probed on production.

## Process law
- [ ] Every visual-change agent LOOKS at its own rendered output (screenshots, at
      the sizes users see, at zoom where detail matters) BEFORE presenting.
      Evidence assembled without being looked at is the named failure mode.
