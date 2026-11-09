# 25. A group chat is a room the agents live in, not a request

Status: Accepted (2026-11-09, the owner's decision: the agents of a group chat live in a real,
real-time room where they talk to each other "como un chat de grupo de una app de chat").
Phase 1 is the API; the SDK and the app (Phase 2) follow.
Date: 2026-11-09.

## Context

A group conversation is a `conversations` row without an `agent_id` plus one `conversation_members`
row per agent (`db/schema/chat.ts`). Until now a person's message was answered inside the chat
request: `runGroupTurn` ran every member once, one after another, sharing a 70-second budget under
the request's 80-second cut. The consequences were structural, not bugs:

- nobody could address another member: a reply never reached anyone but the person;
- nothing continued after the request ended, so a conversation between agents could not exist;
- six members could not all fit in the budget, so late members were reported failed;
- the work lived and died with one HTTP connection, on one instance.

ADR 0020 made every agent the same agent and `consultAgent` already runs "a nested, streamed,
paid-for agent turn" (`lib/tools/agent-turn.ts`); ADR 0011 made agents durable and able to speak
first. What was missing is a place for several of them to speak to each other that is not a request.

## Decision

1. **The room is the unit, and it runs in workers.** A person's message is stored, then the chain
   that answers it runs as jobs on a `group-rooms` BullMQ queue (`lib/chat/room/queue.ts`, the
   pattern of `lib/alia-task-queue.ts`, including direct execution without Redis). A chain is a
   sequence of steps, one member each; a step is one job and enqueues the next when it ends.
2. **One speaker at a time per room, across instances.** Every step takes the room's lock
   (`room/lock.ts`: Redis `SET NX PX` with a renewed lease and a token-checked release; a promise
   chain per room without Redis) for the whole of reading the transcript, running the member and
   storing the reply. Replies never interleave and each member reads the transcript as it is *now*.
3. **A member's turn is `runAgentTurn`, unchanged**: credits reserved and settled per turn, the
   member's own memory and tools (never Alia's), typed failures, no filler text. A failure ends that
   member's turn with `alia.agent_end` `failed`; nothing is stored and the chain goes on.
4. **Members talk by `@mention`** (`room/policy.ts#parseMentions`): name or handle, case- and
   accent-insensitive, `@Nadia Ruiz`, `@NadiaRuiz` or the first name when unambiguous, never the
   speaker itself, never a non-member (the roster is fixed when the chain starts). A mentioned member
   goes to the front of the queue and reads the whole transcript. A member that was handed the floor
   may answer exactly `[pass]` (`PASS_SENTINEL`): nothing is stored or published but its end, and it
   is not an error. A person who mentions members is answered by those first; with no mention every
   member answers in the group's order, as before.
5. **Each member is told it is in a group chat**: who is in it, that anyone may talk to anyone with
   `@name`, to speak in its own voice and add only what is its own (`roomPrompt`).
6. **Authority is minted at the edge and carried as an id.** The request holds the person's bearer; a
   worker must not. `room/start.ts` checks `canReachAgent` (including the surface, ADR 0021) per
   member, stores the person's message and mints one Oxy task per member (`createOxyTask`, origin
   `request`, actor = the member's bot account, the pattern of `session-handoff.ts`). The job carries
   only task ids; the worker runs the turn as a task turn (`isDirectSession: false`, `taskId`),
   as background agent sessions do, and revokes the tasks when the chain ends. A task that cannot be
   minted leaves that member without Oxy apps — less authority, never more.
7. **Real time is an event bus** (`room/bus.ts`). The engine publishes `alia.agent_start`,
   `agent_delta`, `agent_tool`, `agent_end` (now also `declined`, and `messageId` on completion),
   `group.message` (the stored reply) and `group.idle` (the chain ended, with a reason). The bus is
   Redis pub/sub on the existing clients, an in-process emitter without Redis. Each event is also
   pushed to the person's sockets as `group:event` through `getIO()` to `user:<id>`, scoped by
   `conversationId` and `chainId` (the Socket.IO Redis adapter carries it across instances).
8. **The chat request becomes one subscriber** (`lib/chat/group-turn-http.ts`). It stores and
   enqueues, subscribes *before* queuing so it misses nothing, forwards the chain's events as the
   exact SSE frames it always sent, and ends cleanly when the first round settles or at
   `GROUP_REQUEST_BUDGET_MS` (70 s). A member still running then is closed on the wire with a typed
   `room_continues` end; its reply is stored and pushed anyway. A declined member is invisible. When
   the first round ends with nobody having answered, the request still ends with the typed
   `EMPTY_RESPONSE` failure. The SSE frame shapes and the `/v1` contract are unchanged.
9. **Replies are stored by the worker** under `group-reply-<person message id>-<turn>`. The id is
   derived from the step, so a retried step finds its reply and does not answer twice, and the prefix
   makes `saveConversation` keep a reply a client had not seen yet (the role `agent-push-` plays for
   outreach; `isAgentWrittenMessageId`). No schema change.

### Bounds (why each exists)

A room is the first place where agents can trigger agents, so every bound is the reason a loop or a
bill cannot grow. All are in `room/policy.ts` and tested as pure functions.

| Bound | Value | Reason |
|---|---|---|
| Replies per person message | 12 | The hard cost ceiling of one message: a full group of six plus a handful of hand-offs. |
| Turns per person message | 24 | A failed or declined turn is still work (a model call, a credit hold). |
| Mention hand-offs per chain | 3 | Person, A, B, C, D is a real exchange; beyond it two agents that keep mentioning each other are a loop. |
| Hand-offs per reply | 2 | A reply that mentions everybody must not fan out. |
| Nobody twice in a row | — | The speaker of the latest reply is skipped as next; a reply never answers itself. |
| Supersede | newest person message | A step runs only while its person message is the latest in the conversation (read from the store, so it holds across instances); the older chain skips and gives its tasks back. |
| Rate | 60 replies per room per 10 min | A person sending quickly supersedes chains but a running turn is paid for. |
| Credits | per turn | Each turn reserves and settles through `reserveBackgroundProductCredits`; no credits is that member's `failed`. |

## Consequences

- A group no longer fits or fails by the request's clock: a slow member does not starve the others,
  and the conversation continues after the request.
- The person's message is stored before anyone answers (it used to be stored with the replies). A
  group where nobody is reachable now stores the person's message only if at least one member is.
- The job data holds ids, never bearers. Redis holds the transcript-free job (ids and counters) for
  the retention of BullMQ; the transcript is read from Postgres per step.
- Step failures from infrastructure (database, lock) are retried once by BullMQ; a step whose retries
  are spent publishes `group.idle` `error` and revokes the tasks, so a room never stays "typing".
  Delivery of events is at-most-once; the stored message is the record.
- Streaming deltas are published one per model delta, to Redis and to the socket adapter. Coalescing
  is an optimisation not made here.
- Phase 2 (SDK/app) consumes: the `group:event` socket event; `group.message` to append a stored
  reply; `alia.agent_start`/`agent_end` for typing state, with `declined` and `failed` clearing it;
  `group.idle` as "the room is quiet"; and the `group-reply-` ids when reconciling with a reload.

## Alternatives considered

- **Keep orchestrating inside the request, with a larger budget or parallel members.** Rejected:
  it cannot let members address each other after the person's turn, dies with the connection and
  scales with one instance's request, which is the problem to remove.
- **One long-lived "room actor" process per conversation (a Durable Object style).** Rejected: this
  stack has no such runtime; a per-room lock over a queue gives the same ordering with the
  infrastructure that exists (BullMQ, Redis) and survives instance loss.
- **A job per member enqueued all at once, with only the lock for ordering.** Rejected: order would
  then depend on the queue's arrival order and mention hand-offs could not take the floor next. A
  chain whose step enqueues its successor makes the order explicit and testable.
- **A deadline-free supersede flag in Redis.** Rejected: the newest person message in Postgres is
  already the truth and needs no second store.
- **Reusing `agent-push-` ids for room replies.** Rejected: that prefix counts against an agent's
  check-in budget (`outreach-budget.ts`); a room reply is not a check-in.
- **Carrying the person's bearer in the job.** Rejected: bearers do not belong in Redis; the Oxy task
  is the sanctioned delegation (ADR 0022).

## Enforcement

- `room/__tests__/policy.test.ts`: mention parsing (case, accents, ambiguity, self, non-members),
  the first round, `planNext` (hand-offs, depth, caps, twice-in-a-row, termination), supersede, rate,
  the decline sentinel and the prompt.
- `room/__tests__/engine.test.ts`: the engine on an in-memory store, bus and lock with a fake
  `runAgentTurn`: order, transcript reading, failure isolation, decline, retry idempotency,
  supersede, rate limit, caps and per-room serialization.
- `room/__tests__/bus-lock.test.ts`: both buses and both locks.
- `lib/chat/__tests__/group-turn-http.test.ts`: the request as a subscriber.
- `lib/__tests__/background-services.test.ts`: the queue starts and stops with the others.
- Not checked yet: multi-instance Redis behaviour (lock hand-over, pub/sub across tasks) and real
  agent turns have no automated test; they need a staging room.
