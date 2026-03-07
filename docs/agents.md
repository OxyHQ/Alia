# Alia Agents

Last updated: 2026-03-07

Alia runs as a context-agent system that prioritizes autonomous retrieval and policy-safe execution.

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

Persistent entities in MongoDB:

- `ContextSource` - where data lives and how reliable it is.
- `ContextNode` - discovered entities (people, projects, docs, threads, etc.).
- `ContextEdge` - relationships between nodes.
- `RetrievalStrategy` - per-intent navigation strategy.
- `LearningRule` - corrections/preferences/constraints.

Ranking combines freshness, precision, and cost to choose source order.

## Governance

Risk policy is enforced per action:

- `R0` read-only: autonomous.
- `R1` reversible write: autonomous + rollback record.
- `R2` external/unknown impact: approval required.
- `R3` destructive: blocked.

User approvals are interactive and real-time (`alia.approval_request` / `alia.approval_result`).

## Triggers and Proactive Runs

Proactive execution uses `/triggers` only.

Trigger types:

- `schedule`
- `webhook`
- `integration_event`
- `agent_heartbeat`

Each execution is stored in `TriggerExecution` with status, tool calls, tokens, and duration.

## Oxy Event Autonomy

`POST /webhooks/oxy/:serviceId` supports:

- Signature verification.
- Event idempotency (`eventId` dedupe).
- Persistent `AgentSession` creation before queueing.
- Guaranteed notification fallback on autonomous failure.

## Model Abstraction

Public surfaces expose only Alia model IDs (`alia-lite`, `alia-v1`, etc.).
Internal model-routing details are never returned to users.
