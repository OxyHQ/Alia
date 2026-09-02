# Proactive Intelligence

Last updated: 2026-09-02

Alia proactive intelligence has one normalized control plane (`/automations`) and
one scheduler (`trigger-engine.ts`) during the trigger migration. Automation
definitions own actors, exact Oxy actions, data flow, limits and execution mode;
triggers remain only the clock/event adapter for legacy definitions.

## Architecture

1. User message (or external event) arrives.
2. Runtime classifies intent and recalls context graph.
3. The coordinator filters agents whose live capability map cannot cover the
   event and every declared action.
4. Observation mode records the selected actor and action graph without making
   a session or an external effect.
5. Execution mode loads opaque, durable Oxy authorization ids and asks Oxy for
   a fresh capability ticket bound to the current run and step.
6. Result is stored and optionally notified.

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

Normalized runs also write `automation_runs` and ordered `automation_steps`.
Each Oxy step carries its stable action id, fresh run/step correlation and
policy decision. Alia stores no user bearer or app credential.

## Governance and Approvals

- `R0`: auto-run.
- `R1`: auto-run + rollback record.
- `R2`: waits for approval.
- `R3`: blocked.

Approvals emit `alia.approval_request` and `alia.approval_result`.

The Oxy autonomy vocabulary is `read_only`, `draft`, `execute_on_request` and
`autonomous`; the most restrictive live policy wins. Risk classes still govern
Alia-local tools, while Oxy app effects are authorized by exact action/resource
capability tickets.

## Oxy Service Events

Source: `packages/api/src/routes/oxy-service-events.ts`

Behavior:

- Authenticate the publisher with an Oxy service identity and its signed app catalog.
- Dedupe by `(appId, eventId)` in `automation_events`.
- Match explicit source resources and deterministically select an eligible agent.
- In observation mode, persist the decision graph and execute nothing.
- In execution mode, require live capability coverage plus every durable action authorization before queueing.
- If autonomous execution fails, send an in-app/push fallback notification.

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

Scheduled execution remains trigger-engine-native until every legacy trigger is
backfilled. `/automations` is the normalized control plane, not a second scheduler.
