# Proactive Intelligence

Last updated: 2026-09-03

Alia proactive intelligence has one normalized control plane (`/automations`) and
one elected scheduler (`trigger-engine.ts`). Automation definitions own actors,
exact Oxy actions, data flow, limits and execution mode. Legacy trigger rows are
read-only audit history and never enter the scheduler or dispatcher.

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

## Automation Scheduler

Source: `packages/api/src/lib/trigger-engine.ts`

The scheduler registers enabled structured definitions whose trigger is a validated
cron expression plus IANA timezone. A 30-second reconciliation loop reschedules edited
definitions and stops removed or disabled ones. The stable leader lease prevents two
tasks from scheduling the same definition during a rolling deployment.

Creation and editing use the same structured contract:

```ts
{
  objective: string;
  trigger: { type: 'manual' | 'event' | 'schedule'; /* type-specific fields */ };
  actorSelection: { mode: 'fixed'; agentId: string }
    | { mode: 'automatic'; eligibleAgentIds: string[] };
  executionMode: 'observe' | 'execute';
  actions: Array<{ resource: ResourceRef; tool: string; input: object; limits: Limit[] }>;
  resources: ResourceRef[];
  dataFlow: { sources: ResourceRef[]; destinations: ResourceRef[] };
  maximumAutonomy: 'read_only' | 'draft' | 'execute_on_request' | 'autonomous';
  limits: Limit[];
  enabled: boolean;
}
```

## Execution Persistence

Each run writes `automation_runs` and ordered `automation_steps`.
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

Scheduled execution is definition-native: `/automations` owns schedules and
`trigger-engine.ts` reads only its normalized repository. `GET /triggers` remains
available for historical inspection; all trigger writes and execution endpoints
return `410 Gone`.
