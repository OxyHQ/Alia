# 25. A group chat is a room the agents live in, not a request

Status: Accepted (2026-11-09, the owner's decision: the agents of a group chat live in a real,
real-time room where they talk to each other "como un chat de grupo de una app de chat").
Date: 2026-11-09.
Revised: 2026-11-12 — natural participation and deliberate silence, approved by the owner.
Extended: 2026-11-12 — durable reaction feedback and selective observation, approved by the owner.

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

### Why participation needed a second decision

The first room implementation kept the old rule: without an `@mention`, every member answered.
It also told each member that the person was asking it. Thus “Hola! Eusebio que puedes hacer?”
activated Salella first, even though the person had addressed Eusebio. Asking the model not to
repeat other replies did not correct the runtime's decision to run all members.

[Grok Bot's public collaboration documentation](https://docs.x.ai/grok-bot/chat-and-collaboration)
describes ordinary messages with selective participation, explicit addressing and handoffs. It does
not disclose its selection algorithm. [AutoGen's Selector Group Chat](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html)
documents a concrete implementation pattern: select a speaker from attributed context, run that
speaker, then evaluate continuation. These are references for behavior and architecture, not a
claim that Alia reproduces Grok Bot's internal implementation.

## Decision

1. **The room is the unit, and it runs in workers.** Store the person's message, then use separate
   selection and speaking jobs on `group-rooms-v2`. The selection is saved in the queued speaking
   job before an agent can run. Job IDs include the phase and turn, so selection cannot collide
   with execution. The old `group-rooms` queue is drained with its original policy.
2. **One speaker at a time per room, across instances.** Both phases take the room lock
   (`room/lock.ts`: a renewed Redis lease and token-checked release, or a local promise chain).
   Read the current stored transcript under that lock. Recheck supersession after selection and
   before speaking: a newer person message ends the older chain.
3. **Selection precedes activity.** A structured `RoomDecision` chooses a speaker, requests one
   clarification, ends the chain deliberately, or reports an unavailable addressee. It sees only
   participant identities, descriptions and attributed conversation data. It has no tools, private
   memory or authority to act. Validate its output against the roster. Run inference through Oxy's
   utility resolver, with bounded time/output and the existing reservation, settlement and refund
   lifecycle; record consumption and decision metadata without transcript text. A returned generation
   settles its measured usage before semantic roster validation, so rejecting its actor ID does not
   refund inference that completed. An inference call that throws releases its reservation.
   For ordinary messages, the inference schema is `{ choice: <allowed decision ID> }`:
   the server supplies `allowedChoices`, each representing one complete legal decision for the
   current room state, maps the chosen ID to `RoomDecision`, and retains the existing validator.
   A real-inference evaluation exposed an incompatible `clarify`/`directed` combination when
   action, actor and reason were independent output fields. Enumerating complete decisions
   removes that invalid combination without keyword routing or relaxed validation. It does not
   guarantee that the model selects the contextually best option; real-inference acceptance
   remains necessary. Reaction observations keep their separate `speak`/`idle` action schema
   and server-bound recipient. These are internal inference contracts; authority, budgets,
   retry limits, persisted `RoomDecision` shape and public product contracts are unchanged.
4. **Addressing is contextual.** A bare name and an `@mention` can both address a member. A name in
   a quote, code, explanation or reference to a previous answer is not automatically an invitation
   to speak. Follow-up questions use the conversation context. An ambiguous addressee produces one
   clarification, not several guesses; an unavailable addressee is not silently replaced. General
   requests select useful contributions, without a compulsory round or a permanent lead agent.
5. **Reevaluate after each answer.** The next selection reads the stored reply and decides whether
   a complementary contribution or a genuine handoff is needed. Merely writing `@name` does not
   run another agent. Stop once the request is satisfied. “Gracias, era eso” may end without a
   reply. Deliberate silence is a successful room outcome, distinct from a model returning empty
   text or failing. `[pass]` remains only in the legacy queue's drain policy.
6. **Each actor reads its own conversation perspective.** Use stored `agentInfoId`, not display
   names, to attribute history. Only that actor's own messages are `assistant` messages; peers'
   words are delimited, attributed observations, never the person's instructions or the actor's own
   statements. Keep the person's original message separate from room instructions. Preserve the
   actor's identity, remit, memory and tools; it describes capabilities from what is actually
   available. External agents receive this context through their existing task/history interface.
7. **Authority stays at the edge.** `room/start.ts` checks `canReachAgent` including the surface
   (ADR 0021), then mints each reachable member's Oxy task while the person's bearer is present.
   Jobs carry task IDs, never bearers. A selected member runs through `runAgentTurn` as a task turn
   (`isDirectSession: false`, `taskId`) with its own memory and tools, never Alia's. Failure to mint
   a task gives that member no Oxy apps. Every chain exit revokes its tasks.
8. **Real time remains the existing event bus.** The bus publishes `alia.agent_start`,
   `agent_delta`, `agent_tool`, `agent_end`, `group.message` and `group.idle`. It uses Redis pub/sub
   or the local emitter and also sends `group:event` on the existing Socket.IO connection. Selection
   itself emits no agent activity. Only a selected actor appears as thinking or answering.
9. **The HTTP request watches the chain, not a fixed round.** Subscribe before enqueueing and
   forward the existing SSE frames until `group.idle`, disconnect or `GROUP_REQUEST_BUDGET_MS`
   (70 seconds). A still-running member ends on that HTTP connection with `room_continues`, and
   continues through sockets and storage. The internal result distinguishes successful silence,
   replies, continuation and failure. Inference failures use `failTurn`, including a failure after an earlier member has already
   answered; keep that partial reply without reporting the chain as successful. A settled chain that
   was not superseded succeeds without an answer only after an explicit idle decision. Supersession
   and background continuation close the HTTP subscription without claiming an answer.
   The SDK recognizes `alia.group_turn`, preserves the
   person's message and removes an empty lead placeholder on successful group completion. Ordinary
   empty one-to-one responses and interrupted streams remain failures.
10. **A stored reply is the execution record.** Keep
    `group-reply-<person message id>-<turn>` IDs. A retried speaking job finds its existing reply
    before running the actor, and the saver preserves replies the client has not seen yet.
    The original message-driven selection and execution change required no database schema
    migration or new public request fields. Reaction observations below add their own durable state.

### Reaction observations

A heart that exists only in the UI is not conversation feedback: the actor cannot perceive it,
and replacing the message rows can erase it. Persist reactions independently of replaceable row
UUIDs, keyed by owner, conversation and stable message ID. Store the attributed recipient,
current emoji set and monotonic revision; use the stored actor identity rather than client-supplied
display metadata. Ordinary turns receive this authoritative context, including an empty set after
removal. A reaction is data, never a user-authored instruction, task or tool approval.

An added reaction to a reachable hosted agent may produce **at most one useful response by that
recipient**, in direct chats as well as groups. Reuse the room selector and actor runner with an
explicit reaction trigger. Simple appreciation can end silently, without forced thanks or visible
agent activity. Do not hand off or run other members. Alia, external agents and unavailable
recipients retain feedback without immediate observation execution. A selected observation runs
without tools, delegation or memory writes; no requester bearer or new tool authority is retained.
The mutation edge checks reach, and workers recheck membership and application boundaries.

The existing reaction endpoint accepts explicit `active` plus a UUID `mutationId`, while retaining
legacy toggle input. A transaction commits canonical feedback, revision and an idempotency receipt,
including no-ops, together with any eligible observation. A Postgres outbox dispatcher uses
renewable leases and persists its decision before execution; it does not put a new payload on
queues consumed by older room workers. Coalesce rapid taps before selecting. Share the room lock,
defer while durable activity markers indicate a substantive turn, and cancel superseded work.
The final reply transaction fences the live lease, current revision and activity against the same
thread lock used by writes and turn admission. Recover a deterministic stored reply instead of
regenerating it after a delivery retry. Silence and inference failure remain different outcomes.

All message writers preserve canonical feedback across rewrites of the same target. Explicit
target replacement or deletion clears it and cancels pending work; conversation deletion cascades
the feedback and receipts. Minimal rolling-compatibility triggers mirror old reaction updates and
restore old writers' inserted caches without creating response authority. Existing feedback is
seeded in the same transaction as these triggers, without retroactive observations. The response and existing
`conversation:reaction` socket event carry stable message ID, emoji set, revision and mutation ID;
history carries `reactionRevision`. This is an event on the existing connection, not a new
WebSocket route. [The runtime contract](../chat-runtime.mdx#reactions-are-conversation-feedback)
defines the fields and recovery behavior.

### Agents can author feedback

An agent may react during its authorized turn to a person or peer message in that conversation.
Bind the reactor to the executing actor on the server, check the reactor's current membership and recheck the
stored target and latest person message atomically. Do not accept author identity from the client
or a model tool argument. This capability does not extend the tool authority of reaction-observation
turns, and a reaction never constitutes consent or approval to act.
An identifiable historical peer message remains a valid target after its author leaves the room;
the reaction does not execute that author or grant it new access.

Preserve the old `reactions` field as the owning person's emoji selection and add attributed
`reactionEntries` for all authors. Store agent entries separately from that legacy projection,
allowing several authors to use the same emoji independently. Use one monotonic snapshot revision,
including for removals; an agent mutation may supersede an older observation but cannot enqueue
one. Existing replacement, deletion and conversation ownership rules apply to every author.

Agent tool receipts are durable and idempotent, but are not evidence of a successful whole turn.
Persist a separate completion only after a clean reaction-only finish backed by the same
actor/thread/turn's receipts. Fence it against supersession and use a canonical admitted-turn key
that also distinguishes trigger content. Queued group recovery delivers an already completed action
without rerunning inference or creating an empty assistant message. Direct chat rejects a reused
turn ID and reloads canonical state on reconnect; a newly admitted retry is a new turn. Direct
`alia.agent_turn` admission and clean-completion markers distinguish stored conversation state from
a successful reaction-only outcome. Nonverbal completions share the existing room rate limit.
This remains an internal Alia
capability and an additive payload on its existing socket event, with no new Oxy authority contract.

### Bounds

| Bound | Value | Reason |
|---|---|---|
| Replies per person message | 12 | Bound the cost of one request and its collaboration. |
| Operations per person message | 24 | Both a selection phase and an actor execution increment the turn counter; failed attempts also consume work. |
| Handoffs per chain | 3 | Bound agent-to-agent exchanges. |
| Consecutive substantive replies | Different member | Prevent an actor from answering itself; a one-off clarification may use the last interlocutor. |
| Selector generation deadline | 10 seconds | Bound the inference call including its retry; credential/credit setup is separate. |
| Selector retries | 1 | One bounded recovery, never a fallback to all members. |
| Selector output | `utilityOutputTokens(512)` | Reserve enough for the decision and Oxy-selected model reasoning. |
| Supersede | Newest person message | An old chain cannot start another actor's work. |
| Rate | 60 replies per room per 10 minutes | Bound repeated requests across chains. |
| Credits | Per inference operation | Selection and actor execution both account for their actual usage. |

## Consequences

- The group can respond to natural language without requiring `@` syntax. In the reported case,
  only Eusebio runs; Salella has neither an answer nor a transient activity indicator.
- A general question may have one or several useful contributions. No member owes an answer just
  because it belongs to the room, and a completed exchange can stay quiet.
- Selection adds a bounded inference call before an actor runs. Schema/roster validation makes
  control flow testable, but understanding a request still requires real-inference evaluation.
- Jobs contain roster metadata, counters, task IDs and a selected decision, not the transcript or
  bearer. Workers load conversation data from Postgres when needed.
- Infrastructure retries and at-most-once event delivery retain their existing limits. The stored
  message is the record after reconnection; the in-process queue fallback is not durable across a
  process restart.
- Roll out SDK handling before activating new group jobs. Keep the legacy queue drain worker until
  its waiting, active, delayed and retryable jobs have finished, then retire it separately. Do not
  reinterpret old round-robin job data as a semantic selection.

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

- Room decision tests validate structured output, roster membership, bounded failures and usage
  accounting. Mocked model outputs prove runtime control, not natural-language understanding.
- Room engine tests cover selection before execution, complementary contributions, silence,
  attributed history, failure behavior, retry identity, supersession, rate/cost bounds and locking.
- Transcript tests verify that shared names or renamed actors cannot turn peers' messages into the
  current actor's own history.
- HTTP and SDK tests cover deliberate quiet completion, typed errors, interrupted streams,
  continued work and SSE/socket reconciliation without empty or duplicate messages.
- Postgres checks exercise the existing stored actor IDs and reply identities. Real inference and
  multi-instance Redis acceptance follow the [group participation evaluation](../testing/group-participation.md).
- Reaction persistence checks passed against real Postgres: idempotent no-op receipts, rapid
  add/remove, stable legacy IDs, concurrent rewrites, actual legacy updates, lease recovery,
  activity exclusion, guarded reply commit and deletion. Selector mocks establish control flow,
  not natural emoji understanding; reaction inference and signed-in UI acceptance require their
  own recorded results rather than inheriting the earlier message-participation acceptance.
