# Alia API

Express + TypeScript API for Alia autonomy runtime.

## What Is Live

- Single chat runtime for all surfaces (`/alia/chat` and `/v1/chat/completions`).
- Autonomy loop with intent classification and context-graph recall.
- Trigger engine (`/triggers`) for schedule, webhook, integration event, and agent heartbeat tasks.
- Oxy service event ingestion with idempotency and autonomous session creation.
- Governance by risk level (`R0` read, `R1` reversible write + rollback record, `R2` approval required, `R3` blocked).
- Public model abstraction: only Alia model IDs are exposed.

## Runtime Flow

1. Classify intent.
2. Recall ranked sources and learning rules.
3. Retrieve context.
4. Execute with tools.
5. Persist learnings and source quality.

## Core Modules

- `src/routes/v1/chat-completions.ts` - Unified chat handler.
- `src/lib/autonomy/runtime.ts` - Before/after chat autonomy orchestration.
- `src/lib/autonomy/context-graph.ts` - Recall/learning engine.
- `src/lib/agent/governance.ts` - Risk policy and rollback registration.
- `src/lib/agent/action-approval.ts` - Approval request/decision lifecycle.
- `src/lib/trigger-engine.ts` - Unified trigger scheduler/executor.
- `src/routes/oxy-service-events.ts` - Oxy event webhook + autonomous execution.

## Public Endpoints

### Chat

- `POST /alia/chat`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`
- `GET /v1/models/:modelId`

### Triggers

- `GET /triggers`
- `POST /triggers`
- `GET /triggers/:id`
- `PATCH /triggers/:id`
- `DELETE /triggers/:id`
- `POST /triggers/:id/run`
- `GET /triggers/:id/executions`
- `POST /triggers/:id/regenerate-token`
- `POST /triggers/webhook/:token`

### Oxy Event Ingestion

- `POST /webhooks/oxy/:serviceId`

### Removed (hard cut)

- `POST /v1/resolve-model` -> `410`
- `POST /v1/report-usage` -> `410`
- `POST /codea/resolve-model` -> `410`
- `POST /codea/report-usage` -> `410`
- All `/automations*` routes removed.

## Streaming Event Contract (`eventVersion: 1`)

Named SSE events used by all clients:

- `alia.plan_preview`
- `alia.approval_request`
- `alia.approval_result`
- `alia.research_progress`
- `alia.agent_session`
- `alia.reasoning`
- `alia.tool_result`
- `alia.title`
- `alia.model_switch`

## Development

```bash
# from repo root
bun run dev:api

# or from apps/api
bun run dev
```

## Build

```bash
bun run build
bun run start
```

## Environment

Use `apps/api/example.env` as baseline.

Key groups:

- Server and CORS (`PORT`, `WEB_URL`, `API_BASE_URL`)
- MongoDB (`MONGODB_URI`)
- Auth secrets (`JWT_SECRET`, `SERVICE_SECRET`)
- Queue/async execution (`REDIS_URL`)
- Integrations and channels (`INTEGRATIONS_SERVICE_URL`, channel secrets)
- Optional sandbox runtime (`DOCKER_HOST_URL`, `DOCKER_HOST_SECRET`)

## Notes

- Keep all user-facing errors sanitized.
- Never expose internal model-routing details in public responses or logs.
