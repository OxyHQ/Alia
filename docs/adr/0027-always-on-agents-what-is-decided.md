# 27. Always-on agents: what is decided, and what is deliberately not built

Status: Accepted (2026-11-10).
Date: 2026-11-10.

## Context

The plan to make agents attentive on their own (ADR 0026, and the sweeps, caps and pause that came with
it) left five questions open. Each was answered by reading the code or by a constraint the stack
already sets, not by a new preference, so they are recorded here to stop being "pending".

## Decisions

1. **The agent's computer stays one per agent per person** (`agentActorId`:
   `agent:<agentId>:user:<oxyUserId>`). It is the isolation of a public agent: one person's files are
   never another's (`docs/agents.md`, "The agent's computer"). For the owner of a private agent — the
   only person its background runs act for — it already IS "the agent's computer". Splitting it into a
   person-independent machine would let a stranger on a public agent reach the owner's workspace, and
   re-keying it would orphan every existing `/workspace` volume. Neither is worth it.
2. **A woken agent notices and tells; it does not act.** The heartbeat run has a follow-up's authority:
   no computer, no MCP, Oxy apps only through exact authorization (ADR 0022). Acting on an event is
   what an **event automation with declared actions** already is: the owner names the exact tool calls
   and Oxy authorizes them per action. Giving a heartbeat run a wider purse would bypass that, so it is
   not done. An owner who wants an agent to act on new mail declares the action.
3. **No memory flush before context compaction.** Compaction trims only the in-memory context
   (`lib/agent/context-compaction.ts`); `event_stream_entries` is append-only and keeps every entry, and
   `agent_sessions` resumes from it. Nothing is lost, so there is nothing to rescue. A flush would cost a
   model call per compaction and write model-summarised content that came from the web or from email
   into the agent's memory, which is exactly the path memory poisoning uses. Memory is written by the
   agent deliberately, through its `memory` tool, and reviewable by its owner.
4. **Computer persistence beyond the volume is infrastructure.** `/workspace` survives a stop; processes
   do not, by design (`--network none`, 10 minutes unused). A copy of the volume elsewhere needs a
   bucket, a role and a Spot-interruption story in `oxy-infra`; the host has nothing to call until they
   exist. It is not started in code first.
5. **The three execution paths stay three.** A chat turn (80 s, streamed), a background run (durable
   session, leased, resumable) and a channel message (acked, then answered; now durable through
   `channel_inbound`) differ in what they promise, and what they SHARE is enforced where it can be:
   typed failures, the credit hold and its release, memory per actor, the identity guard and the
   authority rules are single code (`runAgentTurn`, `ToolPipeline`, `reserveBackgroundProductCredits`)
   with census tests (`one-assembler.test.ts`, `one-thread.test.ts`). Merging the paths themselves is a
   rewrite of billing and retries with no defect to justify it; the next time one of them drifts from
   the shared rules, the census that catches it is the place to fix.

## Consequences

- The only work still outside the repo is #4. Everything else above is closed.
- Open follow-ups that are bugs, not decisions, belong in issues: the alert module
  (`lib/observability/alerts.ts`) is unwired and per-instance, and Alia task retries still repeat
  undeclared side effects other than the Telegram send (that one is idempotent per run).
