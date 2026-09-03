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
- [ ] "made by tejas.nyc" on landing + inspirations ONLY (removed from dashboard
      by Tejas 2026-08-04; NEVER game). Pinned to bottom on every page that has
      it. Landing footer also carries the inspirations link.
- [ ] No ⋯ menu on the landing. ⋯ top-right on dashboard + game; menu holds
      (top→bottom): notifications (interactive, opens the confidence-promise
      popover with the four notification types), installed state, inspirations,
      sign out. Invite-link is NOT in the menu (moved to the Add-a-friend
      disclosure per Tejas 2026-08-04 — copy-invite is a friends action, not
      a settings action).
- [ ] Naming split (Tejas 2026-08-04): the URL already carries the name;
      the <title> should say what the app IS.
      • APP identity "two chairs" (lowercase) — in-app wordmark, manifest
        name/short_name (home-screen install label), APP_NAME env var
        (passkey rpName).
      • DOCUMENT title / share metadata "chess with friends" — index.html
        <title>, og:title, twitter:title, meta description.
      • og:description carries the approved copy line ("No infinite pool
        of opponents. A game happens when two friends sit down.").
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
- [ ] Friends list IS the action surface: online first, then offline. EVERY
      friend row gets an ACTIVE Invite button regardless of presence — the
      challenge push IS the come-online request (Tejas 2026-08-04 correcting
      the earlier online-only spec). Offline state shows via the status dot
      only. ~8 rows then "More friends" disclosure. Challenges persist on the
      server until answered or withdrawn (no TTL).
- [ ] ONE "Schedule a game" disclosure at the BOTTOM of the friends section
      (no standalone schedule section, no per-friend schedule). Paired with
      an "Add a friend" disclosure at the same footer position; expanding
      Add-a-friend reveals the handle input + Add button + Copy-invite-link
      action (invite-link OUT of the ⋯ menu).
- [ ] Schedule = day + time picker (never "start in minutes"). Recurring:
      once / weekly / daily; accept ONCE; push each occurrence; End series from
      either side.
- [ ] Copy-invite-link lives in the Add-a-friend disclosure only.
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
      challenge_accepted, scheduled_start, call_invite — descriptive, not a cap.
- [ ] Waiting room: sending an invite lands sender AT the board ("waiting for @x");
      accept transitions live in place; challenge_accepted push to inviter.
- [ ] Push endpoint ownership: one endpoint belongs to one current user.
      Subscribe transfers ownership and drops stale endpoint queues; logout /
      unsubscribe detach. Pending reads consume by default, ACK remains
      idempotent, and stale entries are TTL-pruned.
- [ ] Push copy contract: `npm run test:push` runs both the policy scanner and
      `scripts/verify-push-copy-contract.mjs`; deploy is blocked if any push
      type lacks an explicit title/body assertion.

## Inspirations / attribution
- [ ] Plain declarative prose only — no AI-slop tells (em-dash chains, clever
      appositives, "X IS Y" constructions, portfolio-caption tone, designer
      voice). Read-aloud test: if it sounds like a designer explaining a joke,
      cut it. Museum/exhibition provenance lines REMOVED. The Workers' Club
      "active and collective rather than passive and solitary" sentence
      present verbatim, full stop after — no "not scrolled alone" clause.
      Hartwig entry REMOVED (Tejas final 2026-08-04; shipped pieces are
      standard Staunton). Rodchenko entry keeps photo + 1925 Workers' Club
      table description; Villalba entry cites palette; Lichess CC0 line;
      made-by. No self-references, no "photo by Tejas"; if the famous
      constructivist pieces are referenced, say they're Lavrentyev/Vasnetsova
      1976, NOT Rodchenko.

## Infra
- [ ] twochairs.club is the single canonical domain. chess.tejas.nyc and
      www.chess.tejas.nyc redirect with 301 to the matching twochairs.club
      path + query; no duplicate app origin.
- [ ] Cloudflare Web Analytics uses the twochairs.club beacon token only.
- [ ] HTML no-cache; hashed assets immutable (deploys reach phones on plain reload).
- [ ] Structured server mutation logs: JSON lines shaped `{ level, event,
      actor, entity: { kind, id }, outcome, latency_ms, error? }` at write
      sites, readable in Cloudflare Workers observability.
- [ ] Client error reporting: `window.onerror` and unhandled promise rejection
      post to `/api/_client_error`; D1 keeps the last 500 records, readable
      only from the local debug endpoint.
- [ ] Full test gate green: mechanics + adversity (+ webkit project where runnable).
- [ ] Every deploy verified live: health, beacon, asset hashes, and the specific
      feature probed on production.

## Process law
- [ ] VISUAL MATRIX SHIP GATE (Tejas 2026-08-04, founding incident: schedule
      form shipped with the Time field crushed under the Repeat dropdown at
      desktop widths). Before EVERY deploy, run `node scripts/visual-matrix.mjs`
      and OPEN the contact-sheet HTML for each viewport (390, 430, 1440)
      AND the iOS Simulator contact sheet. Look at every cell — landing
      (rest / piece-selected / mid-transition), inspirations, dashboard
      (rest / add-friend open / schedule open / menu open / notif popover
      open), waiting room, game (live / selected). Deploy is blocked until
      every cell has been eyeballed. This is the permanent answer to
      "why are we shipping things without looking."
- [ ] SIMULATOR-AS-TRUTH (added 2026-08-04 after Tejas hit an inspirations
      overflow the headless viewports could not see). Headless viewports
      report the full 844/932/900 usable height; mobile Safari's URL bar +
      toolbar consume ~120-190px on device, so `100dvh` math that passes
      headless overflows on the real phone. The visual matrix's MOBILE
      cells MUST be captured on the iOS Simulator (real WebKit, browser
      chrome present) via `xcrun simctl openurl` + `xcrun simctl io
      screenshot`, in addition to the headless capture. Headless stays
      for fast programmatic guards (overlap, geometry) and desktop; the
      simulator is the truth pass for phone surfaces. Any no-scroll
      surface must be verified with browser chrome present.
- [ ] PROGRAMMATIC OVERLAP GUARD (same incident). The `no element overlap
      across the visual matrix` adversity test walks the same surfaces and
      asserts NO two visible labeled controls (input/select/button/textarea/
      label) have intersecting bounding boxes at any viewport. Must be green
      before every deploy. Catches states nobody thought to eyeball.
- [ ] DATA-DEPENDENT STATES ARE MATRIX CELLS (Tejas 2026-08-04, founding
      incident: the WaitingRow shipped mangled — "Waiting for @raz"
      wrapped into three centered lines with the arrow orphaned and
      Withdraw marooned mid-row — because the matrix covered UI states
      like disclosure/menu open but no cell existed for the DATA state
      "dashboard with pending outgoing challenge". A state that only
      exists when data exists is a state nobody looks at unless the
      matrix creates the data.
      The rule: every state a user can be in must have a matrix cell.
      Data-dependent states seed the data via the API and screenshot
      the resulting UI (dashboard with outgoing/incoming challenge,
      live game, accepted schedule, incoming/outgoing friend request,
      zero friends, many friends, past games expanded, waiting room,
      game live/selected/terminal). The matrix creates the pair of
      users, the pending challenge, the accepted schedule — whatever
      the state needs. A state with no cell is a state nobody has
      ever looked at.
- [ ] Every visual-change agent LOOKS at its own rendered output (screenshots, at
      the sizes users see, at zoom where detail matters) BEFORE presenting.
      Evidence assembled without being looked at is the named failure mode.
- [ ] Every SURFACE (landing, dashboard, game, inspirations) carries a layout
      regression in adversity.spec.ts asserting content-column width, offset
      symmetry, and no-scroll-where-forbidden at 390 and 430. Added
      2026-08-04 after a landing-scoped CSS change silently narrowed the
      dashboard column on iOS Safari — surfaces without geometry tests
      regress silently. Cross-surface layout leakage becomes a test failure,
      not a Tejas screenshot.
- [ ] One-owner discipline for layout rules: any rule that shapes a surface
      must be scoped to `body[data-screen="<surface>"]` unless it is a
      genuinely shared pattern (like `.made-by` or `.stage > *`). Shared
      shell-child rules must include `min-width: 0; width: 100%;
      align-self: stretch` on flex children so iOS Safari doesn't fall back
      to intrinsic-min-content width.
