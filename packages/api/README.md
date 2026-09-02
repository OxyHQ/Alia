# Alia API

Express + TypeScript API for Alia autonomy runtime.

## What Is Live

- Single chat runtime for all surfaces (`/alia/chat` and `/v1/chat/completions`).
- Autonomy loop with intent classification and context-graph recall.
- Trigger engine (`/triggers`) for schedule, webhook, integration event, and agent heartbeat tasks.
- Structured automation control plane (`/automations`) for explicit actors, resources,
  data flow, autonomy, observation and execution.
- Oxy service event ingestion with idempotency and autonomous session creation.
- Governance by risk level (`R0` read, `R1` reversible write + rollback record, `R2` approval required, `R3` blocked).
- Model abstraction on the product surface: only the `alia-*` identifiers are exposed.
- PostgreSQL through drizzle as the only store — no MongoDB connection is opened and no Mongoose model is registered.

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
- `src/lib/automation-dispatcher.ts` - Deterministic structured automation coordinator.
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

### Structured Automations

- `GET /automations`
- `POST /automations`
- `PATCH /automations/:id`
- `DELETE /automations/:id`
- `POST /automations/:id/run` (manual definitions; requires `Idempotency-Key`)
- `GET /automations/runs`
- `GET /automations/runs/:runId/steps`

### Removed (hard cut)

- `POST /v1/resolve-model` -> `410`
- `POST /v1/report-usage` -> `410`
- `POST /codea/resolve-model` -> `410`
- `POST /codea/report-usage` -> `410`

## Streaming Event Contract (`eventVersion: 1`)

Named SSE events written to the chat response stream:

- `alia.plan_preview`
- `alia.model_switch`
- `alia.reasoning`
- `alia.tool_result`
- `alia.agent`
- `alia.agent_session`
- `alia.title`
- `alia.research_progress`

`alia.approval_request` and `alia.approval_result` are **Socket.IO** events
(`src/socket.ts`), not SSE. Nothing writes them to the HTTP stream.

These are Alia **product** events. They are not part of any generic inference contract —
see `docs/adr/0004-product-endpoints-versus-generic-inference-endpoints.md`. Exact payload
fields and emitting lines are in `docs/chat-runtime.mdx`.

## Development

```bash
# from repo root
bun run dev:api

# or from packages/api
bun run dev
```

## Build

```bash
bun run build
bun run start
```

## Environment

Use `packages/api/.env.example` as the baseline; it carries a per-variable note.

Key groups:

- Server and CORS (`PORT`, `WEB_URL`, `API_BASE_URL`)
- PostgreSQL (`DATABASE_URL`) — the one variable the process cannot start without
- PostgreSQL is the only database; there is no Mongo connection string or driver dependency
- Identity and internal auth (`OXY_API_URL`, `SERVICE_SECRET`, `TOKEN_ENCRYPTION_KEY`)
- Queue and async execution (`REDIS_URL`)
- Integrations and channels (`INTEGRATIONS_URL`, `INTEGRATIONS_SECRET`, channel secrets)
- Optional sandbox runtime (`DOCKER_HOST_URL`, `DOCKER_HOST_SECRET`)

Upstream model credentials are not environment variables — they live in the
`provider_keys` table. Leave `GATEWAY_API_URL` unset; there is no gateway service.

## Notes

- Keep user-facing errors sanitized through `sanitizeMessage()`.
- Keep upstream routing detail off product responses. Logs are the opposite case: they are
  an operator surface and must name the deployment that failed.
