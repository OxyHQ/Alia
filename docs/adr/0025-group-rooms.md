# 25. A group chat is a room the agents live in, not a request

Status: Accepted (2026-11-09, the owner's decision: the agents of a group chat live in a real,
real-time room where they talk to each other "como un chat de grupo de una app de chat").
Date: 2026-11-09.
Revised: 2026-11-12 — natural participation and deliberate silence, approved by the owner.

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
   lifecycle; record consumption and decision metadata without transcript text.
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
   replies, continuation and failure. Inference failures use `failTurn`; only deliberate silence
   can finish successfully with no answer. The SDK recognizes `alia.group_turn`, preserves the
   person's message and removes an empty lead placeholder on successful group completion. Ordinary
   empty one-to-one responses and interrupted streams remain failures.
10. **A stored reply is the execution record.** Keep
    `group-reply-<person message id>-<turn>` IDs. A retried speaking job finds its existing reply
    before running the actor, and the saver preserves replies the client has not seen yet.
    Selection and execution require no database schema migration or new public request fields.

### Bounds

| Bound | Value | Reason |
|---|---|---|
| Replies per person message | 12 | Bound the cost of one request and its collaboration. |
| Turns per person message | 24 | Failed attempts also consume work. |
| Handoffs per chain | 3 | Bound agent-to-agent exchanges. |
| Consecutive speaker | Different member | Prevent an actor from answering itself. |
| Selector deadline | 10 seconds | Bound routing latency, including its retry. |
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
