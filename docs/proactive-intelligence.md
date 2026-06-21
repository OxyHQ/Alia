# Proactive Intelligence

Last updated: 2026-03-07

Alia proactive intelligence is built on `triggers` + autonomy runtime + policy controls.

## Architecture

1. User message (or external event) arrives.
2. Runtime classifies intent and recalls context graph.
3. Trigger/action executes with tools.
4. Governance checks risk (`R0`..`R3`).
5. Result is stored and optionally notified.
6. Learnings update source ranking and rules.

## Trigger Engine

Source: `packages/api/src/lib/trigger-engine.ts`

Supported trigger types:

- `schedule` - cron/daily/interval.
- `webhook` - token endpoint with optional HMAC/IP checks.
- `integration_event` - matched by `service + event + filters`.
- `agent_heartbeat` - periodic agent health/status checks.

## Trigger Action Contract

```ts
{
  prompt: string;
  agentId?: ObjectId;
  roleId?: string;
  useTools: boolean;
  notify?: boolean;
  channelId?: string;
}
```

## Execution Persistence

Each run writes a `TriggerExecution` record with:

- `status`: running/success/failed
- input context (`event`, `payload`, `source`)
- output summary
- tool calls
- token usage
- duration

## Governance and Approvals

- `R0`: auto-run.
- `R1`: auto-run + rollback record.
- `R2`: waits for approval.
- `R3`: blocked.

Approvals emit `alia.approval_request` and `alia.approval_result`.

## Oxy Service Events

Source: `packages/api/src/routes/oxy-service-events.ts`

Behavior:

- Dedupe by `eventId`.
- Store event log (`OxyServiceEventLog`).
- For autonomous events, create persistent `AgentSession` before queueing.
- If autonomous execution fails, send fallback notification.

## Client Event Parity

All chat clients consume the same named events with `eventVersion: 1`:

- `alia.plan_preview`
- `alia.approval_request`
- `alia.approval_result`
- `alia.research_progress`
- `alia.agent_session`
- `alia.reasoning`
- `alia.tool_result`
- `alia.title`
- `alia.model_switch`

## Important

Scheduled/proactive execution is trigger-native.
