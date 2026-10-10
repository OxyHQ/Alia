# Alia API

Express + TypeScript API for Alia, Oxy's assistant. Who acts in it (Alia and the
person's agents) is mapped in [`docs/actors.mdx`](../../docs/actors.mdx); the doc index
is [`docs/index.mdx`](../../docs/index.mdx).

## What Is Live

- Single chat runtime for all surfaces (`/alia/chat` and `/v1/chat/completions`).
- Autonomy loop with intent classification and context-graph recall.
- Structured automation control plane (`/automations`): every task has an actor, Alia by
  default (`docs/proactive-intelligence.md`).
- Oxy service event ingestion with idempotency and autonomous session creation.
- Governance by risk level (`R0` read, `R1` reversible write + rollback record, `R2` approval required, `R3` blocked).
- Real models from Oxy's catalogue: a power level (`auto` … `ultra`) or `<publisher>/<model>`;
  the serving operator and deployment ids stay off the product surface (`docs/model-abstraction.mdx`).
- PostgreSQL through drizzle as the only store.

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
- `src/lib/trigger-engine.ts` - Elected structured-automation scheduler.
- `src/lib/automation-dispatcher.ts` - Deterministic structured automation coordinator.
- `src/routes/oxy-service-events.ts` - Oxy event webhook + autonomous execution.

## Public Endpoints

### Chat

- `POST /alia/chat`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`
- `GET /v1/models/:modelId`

### Oxy Event Ingestion

- `POST /webhooks/oxy`

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
- `/codea/*`, `/developer/*`, `/triggers/*`, `/external-models/*`,
  `/api/sessions/:conversationId`, `POST /auth/authorize/{codea,cowork}` and
  `POST /auth/token` were deleted with the retired `alia_sk_*` keys and the
  dropped tables they served (`404`)

## Streaming Event Contract (`eventVersion: 1`)

Named SSE events written to the chat response stream:

- `alia.plan_preview`
- `alia.reasoning`
- `alia.tool_result`
- `alia.agent`
- `alia.agent_turn`
- `alia.context`
- `alia.title`
- `alia.research_progress`
- `alia.suggest_new_conversation`

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
- PostgreSQL is the only database
- Identity and internal auth (`OXY_API_URL`, `TOKEN_ENCRYPTION_KEY`, and —
  locally only — `OXY_SERVICE_API_KEY` / `OXY_SERVICE_API_SECRET`; a deployed
  task attests its ECS role instead and carries neither, oxy ADR 0026)
- Queue and async execution (`REDIS_URL`)
- Integrations and channels (`INTEGRATIONS_URL`, `INTEGRATIONS_SECRET`, channel secrets)
- The agents' computer (`ALIA_COMPUTER_HOST_URL`, `ALIA_COMPUTER_HOST_INSTANCE_ID`; optional)

Upstream model credentials are not Alia configuration. Kaana owns them in its
database; Alia must not receive them through environment variables, SSM or its own
Postgres schema. User-supplied local-runtime bindings are a separate compute boundary
and are never reused for hosted inference.

## Notes

- Keep user-facing errors sanitized through `sanitizeMessage()`.
- Keep upstream routing detail off product responses. Logs are the opposite case: they are
  an operator surface and must name the deployment that failed.
