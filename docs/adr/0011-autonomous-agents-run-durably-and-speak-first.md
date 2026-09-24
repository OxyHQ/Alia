# ADR 0011: Autonomous agents run durably and may speak first

## Status

Proposed

## Date

2026-09-24

## Context

Alia is meant to hold a library of agents that work on their own: take on long
tasks, come back later, and write to the person when there is something to say
— what Meta's Muse, Grok's bots, Manus and ChatGPT Tasks all do. On 2026-09-24
the runtime could not:

- A background run had no owner. A worker that died left the row `running`
  forever, holding credits and an admission slot, and a redelivered job
  restarted it from zero.
- Every sandbox/unknown tool was R2, and an R2 in a background run waited 60s
  in memory for a prompt nobody could see, then counted as denied.
- An agent reached the person only as a push when a job ended; nothing it did
  appeared in the conversation, and it could not schedule itself.
- `agent_memory_documents` was read by nothing at runtime.
- A chat turn has 80 seconds (`routes/v1/chat-completions.ts`), and ADR 0009
  forbids launching a second session from chat.

## Decision

1. **A background run is owned through a lease.** A worker claims the row with
   one conditional UPDATE (`claimAgentSessionRun`,
   `packages/api/src/db/agents/agentSessionRepository.ts:861`), renews it every
   20s, and resumes from persisted events, plan and counters. A reaper
   (`lib/agent/run-reaper.ts:42`) re-enqueues lapsed runs and fails and refunds
   one after three claims.
2. **Risk is classified by what a call does.** Sandbox-free primitives are
   R0/R1; R2 is reserved for effects outside Alia.
3. **A background run never waits for an approval.** It files a durable
   request, tells the person, and continues (`deferredApprovalsFor`,
   `lib/agent/deferred-approvals.ts:57`). Approving starts a new run whose one
   call is let through by a matching, single-use grant.
4. **An agent may write into its conversation with the person**
   (`postAgentMessage`, `lib/agent/agent-outreach.ts:70`): results always;
   its own check-ins at most 3 a day per person, none while its last two are
   unanswered. It may schedule its own follow-ups (max 5 pending). The saver
   keeps such a message even from a client that has not seen it
   (`keepAgentOutreach`, `lib/conversation-saver.ts:205`).
5. **Each agent keeps its own memory of each person** (MEMORY.md and topic
   files), in its prompt and editable by its `memory` tool, under the memory
   grant.
6. **Amending ADR 0009's "no second session is launched from chat":** an
   agent's chat turn may hand work to a background run of the SAME agent,
   explicitly and by its own tool call (`continueInBackground`,
   `lib/agent/agent-turn-coordinator.ts:70`). What 0009 prohibits — a session
   started implicitly beside every chat, with a different destination — stays
   prohibited: this run is admitted per person, holds its own credits, is
   linked to the thread, and posts its result into the same conversation.

## Consequences

- Deploys and crashes no longer lose or duplicate agent work.
- An agent can be proactive, which also means it can be noisy: the outreach
  budget is the only brake, and it is per agent.
- The chat path itself is still one HTTP request of 80 seconds. Moving every
  chat turn onto the durable runtime (a run the request subscribes to) is not
  decided here.
- An agent's "soul" (`lib/agent/soul.ts`) is still not injected into prompts:
  it evolves across all of an agent's users, and its `currentFocus` could carry
  one person's topics into another's prompt.

## Alternatives considered

- **Temporal / Inngest for durability.** Rejected for now: Postgres + BullMQ,
  already deployed, carry a lease and a reaper with no new infrastructure.
- **Waiting longer for approvals in the background.** Rejected: nobody is
  watching, so any wait is wasted worker time and ends the same way.
- **One shared agent budget for outreach across all agents.** Not chosen yet;
  a person with many agents can receive more messages than with one.

## Enforcement

- Leases: `src/db/__tests__/agentSessionRunLease.pgdb.test.ts` (one winner of
  a racing claim, lapse, renewal by a non-owner refused).
- Outreach survives the client: `src/lib/__tests__/conversation-saver.pgdb.test.ts`.
- Deferred approvals: `src/db/__tests__/agentApprovalGrant.pgdb.test.ts`
  (spent once) and `src/lib/agent/__tests__/governance-policy.test.ts`.
- No check exists yet that an agent's outreach budget holds across all its
  entry points; it is enforced only in `postAgentMessage`.
