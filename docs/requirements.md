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
- Handle-based identity. No email, no phone number. Account is device-bound in v1;
  losing the device means friends re-add you (documented, acceptable). Recovery
  (passkey/export) is a later addition.
- Add friends by handle search or shareable invite link. Friend requests require
  acceptance.
- Groups: shelved. Data model may anticipate them; no UI.

**Presence, challenges, scheduling**
- Presence (which friends are online) is visible ONLY when you open the app.
  There is NO notification for a friend coming online — that is a re-engagement
  hook and is permanently out, not deferred.
- Challenge flow: pick a friend, send an invite → they get a push notification →
  accept starts the game.
- Scheduling: propose a game time to a friend → they accept → both get a push
  notification when the time arrives. This is the "time and place" mechanism —
  no calendar integration, no recurring cadence in v1 (later if wanted).

**Notifications (the whole policy)**
Exactly three pushes exist: (1) game challenge received, (2) friend request
received, (3) scheduled game starting. Nothing else — no presence, no streaks,
no "come back" nudges, ever. This is an invariant, not a default.

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

## Open items (Tejas)

- Real name for the app/domain (e.g. <name>.tejas.nyc).
- In-game chat: lean NO for v1 (friends already have channels; less to moderate).
- Spectating friends' live games: nice-to-have, not v1.
- Sound/haptics on moves: implementer's taste, keep it calm.
