# Chess with friends — requirements (v1)

*2026-08-02. Working name only — project needs a real name.*

## Thesis

The anti-chess.com. Chess.com optimizes for infinite opponents and one more game;
this app makes **scarcity of opponents the feature**. You can only play when someone
you actually know sits down across from you. The constraint IS the product — the app
encodes the player's intentions (play deliberately, only with friends, on a schedule)
instead of a market's engagement metrics. Related essay stub:
chann.app `src/content/notes/software-narrows-back-down.md` (BYOC — bring your own
constraints).

## v1 scope

**Games**
- Live-only, two-player chess between friends. No matchmaking pool, no strangers,
  no bots/engine opponents (practice mode is a possible later addition).
- Time controls: rapid 10|0 as the default; blitz 5|0 as the second option. Server
  is authoritative over clocks and move legality (standard open-source chess rules
  implementation — do not reinvent chess).
- Async/correspondence chess is OUT of v1 but must remain addable: nothing in the
  data model or game lifecycle should assume both players are always connected
  (games have persistent state; "live" is a policy, not an architecture).

**Identity & friends**
- Handle-based identity. No email, no phone number. The account credential is a
  **passkey** (WebAuthn): created at signup, it syncs via iCloud Keychain on
  Apple and Google Password Manager on Android — free multi-device access and
  recovery with no identifier collected. A session cookie keeps day-to-day use
  frictionless; the passkey is the anchor when the session is gone. Losing ALL
  devices in an ecosystem loses the account (acceptable, documented).
- Add friends by handle search or shareable invite link. Friend requests require
  acceptance.
- Groups: shelved. Data model may anticipate them; no UI.

**Presence, challenges, scheduling**
- Presence (which friends are online) is visible ONLY when you open the app.
  There is NO notification for a friend coming online — that is a re-engagement
  hook and is permanently out, not deferred.
- During an active game, the opponent's connection state (connected / reconnecting
  / gone) is shown as an in-game UI indicator. This is game state, not a push —
  you're already looking at the board.
- Challenge flow: pick a friend, send an invite → they get a push notification →
  accept starts the game.
- Scheduling: propose a game time to a friend → they accept → both get a push
  notification when the time arrives. This is the "time and place" mechanism —
  no calendar integration, no recurring cadence in v1 (later if wanted).

**Notifications (the whole policy)**

The policy is a PRINCIPLE, not an enumeration:

> Notifications are minimal and useful: one exists only when it serves the
> user's own intention — a request TO them, a handshake THEY initiated
> completing, a time THEY agreed to arriving. The banned category is
> re-engagement: anything that exists to pull the user back for the app's
> sake — presence pings, streaks, activity nudges, "your friend just
> beat their record", "you haven't played in 3 days" — is permanently
> out, not deferred.

The current pushes are a descriptive snapshot of what the principle
presently produces. Adding to this set is fine iff the new push satisfies
the principle. Removing is fine if a use case turns out not to. There is
no "exactly N" cap:

- `friend_request` — someone requested you as a friend
- `challenge` — a friend invited you to a game
- `challenge_accepted` — the friend you invited accepted; your game is ready (completes a user-initiated handshake; explicitly added 2026-08-03)
- `scheduled_start` — a game you both agreed to a time for is starting
- `call_invite` — a friend you are playing with wants to talk, and you are
  not already foreground on that game

Enforcement: `scripts/verify-push-policy.mjs` scans `src/worker.ts` and
`public/sw.js` — every `enqueuePush` call site must use a type in this
list, and no notification-like literal may name a re-engagement category.
`scripts/verify-push-copy-contract.mjs` scans the tests — every current
push type must have an explicit copy assertion marker.
The list is not the policy; the principle is. If a future push satisfies
the principle, add it to both the code and this list in the same change.

Push endpoint invariant: one browser push endpoint belongs to one current
user. Subscribing an endpoint transfers ownership to that user, removes it
from every other user, and drops any stale pending endpoint queue. Logout /
unsubscribe detach the endpoint. Pending endpoint payloads are scoped to
their `userId`, consumed on read, and TTL-pruned so old service workers
cannot pin a stale notification forever.

**Anti-addiction invariants**
- No rating ladder, no ELO, no streaks, no puzzles feed, no daily anything.
- No infinite-next-game affordances. Rematch is fine (a friend consenting is the
  natural rate limiter).

## Platform: PWA (decided)

- Installable web app, one codebase, phone + desktop. Distribution is a URL.
- Web push: iOS requires add-to-home-screen (16.4+; Declarative Web Push where
  available for reliability) — the app must include a guided install flow for
  iPhone (share sheet → Add to Home Screen) and prompt for notification
  permission from an intentional user gesture. Android/desktop push is standard.
- Live-game resilience: phones lock and sockets drop mid-game. Reconnection must
  be seamless and the server-authoritative clock/game state means backgrounding
  can't corrupt or cheat a game.
- Content renders without JS-hostile tricks; the app is a real app, but the
  install/landing page should work everywhere.

## Infrastructure constraint

Tejas's stack: Cloudflare (Pages/Workers/Durable Objects preferred — a DO per
game is a natural fit; $5 Workers Paid is acceptable when needed). The app will
live on a tejas.nyc subdomain (app-like tenants get subdomains per
chann.app/docs/runbooks/publish-subdomain.md). Zone web-analytics beacon applies.

## Definition of done (v1)

The build is not done until two simulated clients have played through EVERY
mechanic end-to-end — account creation, friend request via handle and via invite
link, challenge → accept → full game to each terminal state (checkmate, resign,
timeout), clock correctness, mid-game disconnect + reconnect with the indicator
showing, schedule → accept → notification fire — with screenshots captured at
each step and visually verified. Self-review by independent reviewer agents
happens BEFORE reporting back; the report includes the screenshot evidence.

## Decided (2026-08-02 round 2)

- In-game chat: NO for v1.
- Groups: shelved (data model may anticipate; no UI).
- Working subdomain: antichess.tejas.nyc — PROVISIONAL. Flagged: "antichess" is
  an existing chess variant (losing chess); rename candidates before launch.

## Open items (Tejas)

- Final name (pre-launch decision, not blocking the build).
- Spectating friends' live games: nice-to-have, not v1.
- Sound/haptics on moves: implementer's taste, keep it calm.
