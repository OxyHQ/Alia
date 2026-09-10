# ADR 0009: Agent threads are durable execution units

## Status

Accepted

## Date

2026-09-10

## Context

Alia represented a thread as a view over every conversation owned by a
`(person, agent)` pair. A linked-agent chat ran the ordinary chat loop and, when
`agentMode` was enabled, also started a separately billed autonomous session.
The visible answer and the tool-capable execution therefore had different
lifecycles, event streams and destinations.

That model cannot represent several independent concurrent jobs with the same
agent, durable queue position, per-thread approvals or an execution target.

## Decision

An agent thread is a persisted `agent_threads` row. It owns one or more bounded
conversation stretches. A message in such a conversation creates one durable
agent turn, and that same turn owns its runtime tools and result. No second
session is launched from chat.

Threads store only exact opaque Oxy routing-profile IDs from the reviewed Alia
registry. Hosted inference remains `Alia -> Oxy -> Kaana`.

Normal conversation is billed as inference. A separately explicit goal owns
the agent's marketplace price and an idempotency key.

## Consequences

- One person may open several independent threads with one agent.
- Context remains bounded because a thread may still contain several
  conversations.
- Existing pair-based history remains readable while it is associated with a
  migrated legacy thread.
- Runtime resources are created lazily and governed by the agent's grants.
- Clients must address a selected thread rather than infer it only from a bot
  handle.
- Approval decisions are durable rows; Socket.IO is only their real-time
  transport. Executing replicas poll the database authority.
- Admission is serialized per agent in PostgreSQL, so replicas cannot exceed
  `max_concurrent_threads` through a race.
- A run produces a candidate goal. Completion requires evidence for every
  stored criterion.
- Team packages and Cowork devices use exact stored IDs and owner checks; no
  display-name or ordering lookup grants authority.

## Alternatives considered

- Keep the pair view and add session panels: rejected because it preserves two
  sources of truth and cannot express concurrent work.
- Run every message through the old Hire endpoint: rejected because conversation
  would acquire a marketplace charge and a second transcript.
- Store a model name and resolve it later: rejected by ADR 0003 and the Alia/Oxy
  boundary.

## Enforcement

- `agent_threads_routing_profile_id_check` admits only reviewed opaque IDs.
- Agent chat constructs `AgentTurnCoordinator` and no longer calls
  `startAgentSession` as a parallel escalation.
- App tests require profile actions to create an agent thread and goals to carry
  an `Idempotency-Key`.
- Migration integrity tests require explicit deployment phases.
