# two chairs — observability

## Server mutation logs

Every server mutation emits one JSON line through `console.log`, indexed by
Cloudflare Workers observability:

```json
{ "level": "info", "event": "challenge.accept", "actor": "usr_...", "entity": { "kind": "challenge", "id": "chl_..." }, "outcome": "ok", "latency_ms": 17 }
```

Error logs use the same shape with `level: "error"` and an `error` message.
Use `event` to filter lifecycle transitions, `actor` for one user, and
`entity.id` for a challenge, schedule, game, session, or push target.

To inspect the last hour in Cloudflare:

1. Open Workers & Pages → `chess-with-friends` → Observability → Logs.
2. Filter by `event:"game.move"` or `entity.id:"gam_..."`.
3. Add `actor:"usr_..."` to isolate one player's activity.

Workers Logpush is not represented in `wrangler.jsonc`; it must be enabled
from the Cloudflare dashboard for the account destination Tejas wants. Until
that dashboard toggle is on, Workers Observability is the source of truth.

## Client errors

The browser installs `window.onerror` and `unhandledrejection` hooks. Reports
POST to `/api/_client_error` with:

```json
{ "url": "...", "message": "...", "stack": "...", "userAgent": "...", "userId": "usr_..." }
```

`AppDO` stores a bounded ring buffer of the last 500 records. The local-only
debug endpoint is:

```sh
curl -s http://127.0.0.1:8787/api/debug/client-errors | jq .
```

Production access intentionally goes through Cloudflare logs rather than a
public debug route; the outer worker returns 404 for debug endpoints on
non-local hosts.

## Push delivery

Push delivery attempts log to the AppDO push log and server mutation logs.
For local inspection:

```sh
curl -s http://127.0.0.1:8787/api/debug/push-log | jq .
```

Queued notifications are peeked by the service worker and removed only after
`showNotification()` succeeds and the worker POSTs an ack.
