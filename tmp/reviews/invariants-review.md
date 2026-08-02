# Verdict

Approve.

I found no current product-invariant violation in the repo. The app exposes exactly the three allowed push notification types, keeps play friend-scoped, uses handle/passkey identity without user email or phone fields, avoids the anti-addiction surfaces called out in the requirements, keeps groups/chat out of v1 UI, and is configured as a Cloudflare Worker PWA with Durable Objects.

# Requirement Coverage

- Push policy: `src/worker.ts:13` defines only `friend_request`, `challenge`, and `scheduled_start`; `src/worker.ts:18` centralizes that allow-list; `src/worker.ts:736` to `src/worker.ts:737` rejects any push type outside it. The only enqueue sites are friend request received at `src/worker.ts:622`, challenge received at `src/worker.ts:655`, and scheduled game starting at `src/worker.ts:351` to `src/worker.ts:352`. The service worker also filters inbound push payloads against the same three names before showing a notification at `public/sw.js:2` and `public/sw.js:46` to `public/sw.js:55`. `npm run test:push` passed and reported: `Push policy verified: friend_request, challenge, scheduled_start only.`
- No presence pushes: presence is stored and returned through the in-app session data at `src/worker.ts:117`, `src/worker.ts:514` to `src/worker.ts:527`, and `src/worker.ts:563` to `src/worker.ts:568`. The visible friend online/offline UI is rendered in-app at `src/main.tsx:336` to `src/main.tsx:341`. No presence code calls `enqueuePush`; the only push calls are the three allowed flows above.
- In-game connection state only: the Game Durable Object tracks player socket state at `src/worker.ts:777` to `src/worker.ts:779`, marks reconnecting/gone after socket close at `src/worker.ts:928` to `src/worker.ts:944`, and returns it in the game snapshot at `src/worker.ts:963` to `src/worker.ts:970`. The UI displays it inside the game view at `src/main.tsx:533` to `src/main.tsx:536`.
- Friends-only chess, no matchmaking, no strangers, no bots: challenge and schedule creation both require an existing friendship through `assertFriends` at `src/worker.ts:641` to `src/worker.ts:645`, `src/worker.ts:671` to `src/worker.ts:675`, and `src/worker.ts:731` to `src/worker.ts:734`. Game sockets and actions are restricted to the two game players at `src/worker.ts:838` to `src/worker.ts:856` and `src/worker.ts:947` to `src/worker.ts:951`. I found no matchmaking pool, public opponent list, bot/engine opponent, or practice mode route/UI.
- Handle/passkey identity, no user email/phone: user records contain handle, invite token, and passkey credential records only at `src/worker.ts:31` to `src/worker.ts:44`. Registration/login use SimpleWebAuthn at `src/worker.ts:384` to `src/worker.ts:443` and `src/worker.ts:446` to `src/worker.ts:499`. The auth UI asks only for a handle and explicitly frames the passkey as the account anchor at `src/main.tsx:181` to `src/main.tsx:235`.
- Friend request by handle and invite link: handle requests are implemented at `src/worker.ts:587` to `src/worker.ts:595`; invite-token requests at `src/worker.ts:597` to `src/worker.ts:603`; acceptance creates a friendship at `src/worker.ts:627` to `src/worker.ts:639`. The UI includes both handle entry and invite-link copy/send flows at `src/main.tsx:270` to `src/main.tsx:344`.
- Live-only but async-addable persistence: games are stored in Durable Object storage at `src/worker.ts:993` to `src/worker.ts:999`, AppDO persists game metadata at `src/worker.ts:702` to `src/worker.ts:715`, and reconnect state is independent of legal move/clock state. Game rules and terminal states are server-authoritative through `chess.js` at `src/worker.ts:1`, legal move handling at `src/worker.ts:863` to `src/worker.ts:895`, resign at `src/worker.ts:898` to `src/worker.ts:913`, and timeout at `src/worker.ts:973` to `src/worker.ts:990`.
- Anti-addiction invariants: I found no rating/ELO model, ladder, streak, puzzle feed, daily mechanic, recurring schedule, matchmaking, or infinite-next-game affordance in `src`, `public`, `wrangler.jsonc`, or `index.html`. The only historical game affordance is opening existing games at `src/main.tsx:444` to `src/main.tsx:460`.
- Scheduling constraints: schedules are one-off proposals between friends at `src/worker.ts:671` to `src/worker.ts:699`; accepted schedules fire one scheduled-start push to each player when due at `src/worker.ts:341` to `src/worker.ts:355`. I found no calendar integration or recurring cadence.
- PWA and Cloudflare platform: the app has a manifest at `public/manifest.webmanifest:1` to `public/manifest.webmanifest:18`, service worker install/fetch/push handlers at `public/sw.js:4` to `public/sw.js:67`, an install/notification gesture UI at `src/main.tsx:240` to `src/main.tsx:267`, and Cloudflare Worker plus Durable Object config at `wrangler.jsonc:4` to `wrangler.jsonc:28`.
- Groups, chat, analytics, custom domain: I found no groups UI/model, no chat UI/API, and no analytics script/package in app code. `wrangler.jsonc` has no custom-domain route or zone route; it configures the Worker, assets, vars, and DO bindings only at `wrangler.jsonc:1` to `wrangler.jsonc:28`.

# Findings With File/Line References

No blocking product-invariant findings.

Non-blocking notes:

- `src/worker.ts:280` uses `mailto:hello@example.com` as the VAPID JWT subject. This is not a user email collection path and does not violate the handle/passkey identity invariant, but it should be replaced with an operator-controlled contact before a real launch.
- `src/worker.ts:580` to `src/worker.ts:584` exposes pending allowed push payloads through an authenticated polling endpoint so the service worker can recover a payload when the push event has no data. This does not create a fourth notification type because `public/sw.js:46` rejects unknown types, but the endpoint should remain covered by the push-policy test as the implementation evolves.
- `src/main.tsx:121` to `src/main.tsx:128` sends a presence heartbeat every 10 seconds while the app is open. I do not read this as a violation because presence is visible only inside the app and never pushed, but any future background sync or notification integration around this path would violate the requirements.

# Residual Risks

- This review inspected code and ran the lightweight push-policy verifier; it did not repeat full e2e browser automation or real-device web push delivery.
- Declarative Web Push support is not directly evidenced in the current service-worker/web-push implementation. The current implementation still enforces the three-type notification policy, but iPhone reliability should remain a manual verification item.
- Cloudflare Zone Web Analytics is expected to apply at the future zone/domain layer per the requirements. There is no app-level analytics code here, which is compliant with the no-extra-analytics constraint, but the zone-level setup cannot be verified from this repo alone.
