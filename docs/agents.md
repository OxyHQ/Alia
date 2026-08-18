# Alia Agents

Alia runs as a context-agent system that prioritizes autonomous retrieval and policy-safe execution.

Agents, tools, approvals, the risk policy, deep research and triggers are Alia's own responsibility and stay that way under [ADR 0001](./adr/0001-alia-oxy-relay-responsibility-boundary.md). None of it moves to the Relay data plane.

## Execution Loop

Every interaction follows one runtime loop:

1. `classify` - detect intent.
2. `recall` - load ranked sources + rules.
3. `retrieve` - gather context from top sources.
4. `act` - produce answer and run tools.
5. `learn` - update source quality and learned rules.

This loop is shared across app, Codea, and Cowork.

## Intents

Current first-wave intents:

- `meeting_prep`
- `inbox_digest`
- `project_status`
- `task_followup`
- `monitoring`
- `research`
- `general`

## Context Graph

Persistent entities, read through `db/autonomy/contextGraphRepository.ts`:

- `context_sources` - where data lives and how reliable it is.
- `context_nodes` - discovered entities (people, projects, docs, threads, etc.).
- `context_edges` - relationships between nodes.
- `retrieval_strategies` - per-intent navigation strategy.
- `learning_rules` - learned corrections, preferences and constraints; read through `db/autonomy/learningRuleRepository.ts` rather than the context-graph repository.

Ranking combines freshness, precision, and cost to choose source order.

## Governance

Risk policy is enforced per action:

- `R0` read-only: autonomous.
- `R1` reversible write: autonomous + rollback record.
- `R2` external/unknown impact: approval required.
- `R3` destructive: blocked.

User approvals are interactive and real-time. `alia.approval_request` and `alia.approval_result` travel over Socket.IO, to the `agent-session:<sessionId>` room (`packages/api/src/socket.ts:216`, `:231`) — not over the chat SSE stream.

## Triggers and Proactive Runs

Proactive execution uses `/triggers` only.

Trigger types:

- `schedule`
- `webhook`
- `integration_event`
- `agent_heartbeat`

Each execution is stored in `trigger_executions` with status, tool calls, tokens, and duration.

## Oxy Event Autonomy

`POST /webhooks/oxy/:serviceId` supports:

- Signature verification.
- Event idempotency (`eventId` dedupe).
- Persistent `AgentSession` creation before queueing.
- Guaranteed notification fallback on autonomous failure.

## Model Abstraction

The product surface exposes only the `alia-*` identifiers (`alia-lite`, `alia-v1` and so
on). Upstream routing detail is never returned to users. Several of those identifiers are
routing policies rather than models, and the set is frozen — see
[model abstraction](./model-abstraction.mdx).
