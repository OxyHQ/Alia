# Proactive Intelligence

Last updated: 2026-09-02

Alia proactive intelligence has one normalized control plane (`/automations`) and
one scheduler (`trigger-engine.ts`) during the trigger migration. Automation
definitions own actors, exact Oxy actions, data flow, limits and execution mode;
the elected scheduler reconciles both normalized schedules and legacy trigger
rows without duplicating cron processes.

## Architecture

1. User message (or external event) arrives.
2. Runtime classifies intent and recalls context graph.
3. The coordinator assigns each ordered action to the first eligible agent
   whose live capability map covers it. The first stage must also cover every
   declared source resource.
4. Consecutive actions for the same agent form one stage. Each stage has its
   own session; one run may therefore identify several real Oxy bot accounts.
5. Observation mode records the complete actor/action graph without making a
   session or an external effect.
6. Execution mode loads only that stage's opaque Oxy authorization ids and asks
   Oxy for fresh capability tickets bound to the shared run and exact steps.
7. Stages run sequentially, with one durable session per `(run, stage)`. Each
   declared Oxy action can begin once in that session, and app idempotency keys
   protect effect retries. A prior result reaches the next agent only when the
   definition explicitly names a source and destination for that handoff.
8. The run finishes only after every declared action step succeeds, then sends
   the configured result notification.

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
policy decision. Agent sessions carry an explicit `(automationRunId, stage)`
binding; a unique database index prevents duplicate sessions for one stage.
Alia stores no user bearer or app credential.

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
- Match explicit source resources and deterministically build the eligible
  single- or multi-agent stage plan.
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

Scheduled execution is trigger-engine-native. `/automations` owns normalized
schedules while existing trigger rows remain supported during migration; both
use the same leader lease, cron registry and reconciliation loop.
