# two chairs — state machine rules

*Standing instructions for every future agent touching this app. Read this
before adding a feature, a status field, a boolean flag, or a branch that
depends on server state. Companion to `docs/state-machines.md`, which is
the audit and model.*

## The eight rules

### 1. If it has a lifecycle, it has a state machine

Any entity whose meaning depends on when you look at it — friendship,
invitation, schedule, game, connection, subscription — carries a
lifecycle. That lifecycle belongs in `docs/state-machines.md` before the
code lands, not after. If you can't name the states, you're not ready to
write the code.

Test: read your PR out loud. If the sentences include "sometimes X",
"usually Y", or "after a while Z", those are transitions you haven't
named yet.

### 2. One writer per machine

Exactly one place in the codebase mutates a machine's state. On this
codebase the writer is `AppDO` (for account-scoped entities: friendships,
requests, challenges, schedules, game metadata, sessions, push
subscriptions) or `GameDO` (for per-game state). The client never writes
authoritative state — it dispatches events by calling the writer's API.

If a review comment asks "what if two clients do X at once?" and the
answer isn't obviously "the DO serializes them", the design is wrong. Add
the guard, don't add locking.

### 3. Server is the authority; the client renders a projection

Optimistic UI is fine when the write is cheap and reversible. Even then,
the client shows what the server would show after the write lands — never
a state the server can't reach. When the server reply arrives, the
projection catches up. Don't invent client-only states that don't exist
in the writer's model.

### 4. Every mutation is idempotent

Every write endpoint must be safe to call twice. The second call is a
no-op that returns the current state.

- `create-challenge`: a second call from the same inviter to the same
  target returns the existing pending challenge — never creates a
  duplicate, never fires a duplicate push. (GAP-3 in `state-machines.md`
  is the current violation.)
- `accept-*`, `cancel-*`, `decline-*`, `withdraw-*`: guarded on the
  current status; a second call from the terminal state is a success
  returning the current state, not an error.
- `use-invite-link`: idempotent by design (`requestByInvite`,
  `src/worker.ts:702-750` — cite it as the reference implementation).

Idempotency is what makes retries safe and what defends against the
double-tap.

### 5. Every state has a representation on every surface where the
entity is user-relevant

If a Challenge is `pending` and the inviter is looking at their Friends
list, the row FOR THAT FRIEND must reflect it. If a Schedule is
`accepted` and either party looks at the schedule list, the row must
reflect it. A state you can enter but can't see is worse than no state —
the user acts on stale information.

Do not project the state into ambient UI (a global banner, a toast). The
representation goes where the entity lives — the friend row, the schedule
row, the game row. If two entities share a row (e.g. Bob is a friend AND
the target of a pending challenge), the row surfaces both cleanly.

### 6. Every state has an exit

Every state — including `pending`, especially `pending` — has at least one
transition out that a user or the system can trigger. If the only way to
leave `pending` is for the other person to act, that's a defect. Design
the withdraw, decline, or expire path in the same round as the create
path.

The exception is a true terminal state (`checkmate`, `fired`,
`cancelled`). Terminals are exits. But `pending` is not a terminal.

Where an expire path is right (a schedule whose `startAt` has passed), it
runs on an alarm and marks a distinct terminal (`expired`), not silently
mutates the row.

### 7. Model the machine, not scattered flags

If a feature accumulates two or more booleans to describe its state
(`isPending`, `hasAccepted`, `wasWithdrawn`), replace them with a single
`status` union type. Boolean soup makes illegal states representable
(`isPending: true, hasAccepted: true` — what?) and diffuses the writer
across every place that flips a flag.

Preferred shape in this codebase (matching `Schedule`, `Challenge`,
`Game`):

```ts
type EntityStatus = "pending" | "accepted" | "declined" | "withdrawn" | ...;
interface Entity {
  id: string;
  // ...
  status: EntityStatus;
  // fields specific to one status live alongside; use `?` and rely on
  // the status to decide when they're set.
}
```

Not:

```ts
interface Entity {
  isPending: boolean;
  isAccepted: boolean;
  cancelled: boolean;
  fired: boolean;
}
```

### 8. New features ship with their machine documented and tested

A PR that adds a lifecycle without adding the states and transitions to
`docs/state-machines.md` in the same change is incomplete. A PR that
documents states but doesn't cover them in `tests/adversity.spec.ts` (or
`tests/e2e.spec.ts` for happy paths) is incomplete. The tests must
exercise every transition — including the withdraw/decline/expire paths,
not just accept.

The visual matrix contact sheet (`scripts/visual-matrix.mjs`) captures
each surface × state × viewport. Add a state to a machine → add a matrix
cell for the state's representation. This is how a regression in the
representation shows up before the deploy.

## The checklist to run against any new feature

Before opening a PR, an agent adding or changing a lifecycle answers all
of these in the PR description (or the plan doc it dispatched from). If a
line is blank, the feature is not ready.

1. **States.** What are the disjoint states this entity can occupy? Name
   each one.
2. **Events.** What events cause transitions? For each event, what's the
   guard?
3. **Transitions.** For each `(state, event)` pair, what's the next
   state? Draw the mermaid diagram in `docs/state-machines.md`.
4. **Writer.** Which DO owns writes? Cite the specific handler.
5. **Idempotency.** For every write event, what does the second call do?
   Show the guard in the handler.
6. **Representation.** For every state, on every surface where the entity
   is user-relevant, what does the UI render? Cite the file:line where
   the projection is computed.
7. **Closure.** For every state, name the transition that exits it. If
   an exit is missing (like `pending` with no withdraw), name that as
   the P0 gap and either fix it now or file it in `state-machines.md`.
8. **Test.** Which test in `tests/adversity.spec.ts` covers each
   transition? Which matrix cell in `scripts/visual-matrix.mjs` covers
   each representation?

## Anti-patterns to reject in code review

- **A `status` string used as free text.** If the string can be anything,
  it's not a state. Type it as a union.
- **A client-side `pending` that the server doesn't know about.**
  Optimistic UI is fine — the client must still reflect what the server
  would show after the write. Don't invent client-only states.
- **Two writers.** If two files can mutate the same field, one of them
  is wrong. Even in the same DO, funnel mutations through a single
  method with the guard inside.
- **A `useEffect` that polls forever with no exit.** Every polling loop
  must have a stop condition (`accepted` reached, an error terminal, or
  a component unmount). The `WaitingRoom` polling is the reference case
  (`src/main.tsx:2900-2924`): exits on `status === "accepted"`, unmounts
  cleanly. Once withdraw/decline exist, that loop must exit on those
  too — see GAP-14.
- **A `setTimeout` in a Durable Object.** Not durable across hibernation.
  Use `ctx.storage.setAlarm` or a stored `expiresAt` timestamp promoted
  lazily on read. (GAP-9 in the audit is the current instance.)
- **A projection that isn't marked as one.** If a field exists in two
  places, the copy is a projection. Name it in a comment above the
  field, and make sure the reconciliation path (what happens when the
  authoritative side updates) is explicit. (GAP-10.)
- **Adding a status value without adding the transition into it.** If
  the type union grows a new state, some event must create it. If
  nothing does, delete the value. (`declined` on `Challenge` and
  `Schedule` today — GAP-4, GAP-6.)

## Cloudflare-specific notes

Durable Objects serialize per-DO requests. That gives you the single
writer for free within a DO's boundary. It does not survive across DO
boundaries — the AppDO's copy of a game's status is a projection of the
GameDO's authoritative status, and needs a reconciliation strategy
(retry, resync, or accept the lag).

DOs hibernate. Any state that lives in an instance field (`private
foo: X`) is lost on hibernation. Persist state via `ctx.storage.put`, or
recompute it from persisted primitives at snapshot time.

WebSocket connection state should either use `state.acceptWebSocket()`
for hibernatable sockets, or accept that the DO stays warm for as long as
sockets are open (and dies when they all close). Either way, "who is
connected" belongs in storage or is derived from a snapshot, not from an
in-memory map.

## What good looks like

Look at `use-invite-link` (`src/worker.ts:702-750`):

- Single writer (`AppDO`).
- Idempotent (same call twice returns `already-friends`, no mutation).
- Every branch documented inline with the five cases.
- Every terminal maps to a status the client can render.
- The client's `InvitePanel` (`src/main.tsx:2295-2381`) has a
  representation for each terminal.

That's what a lifecycle looks like when it's designed as a machine
instead of a sequence of feature patches. The rest of this app's
lifecycles are getting there — see `docs/state-machines.md` for the
punch list.
