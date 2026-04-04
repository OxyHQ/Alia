# Deployment Guide

Last updated: 2026-03-07

This guide covers production deployment for the current Clarity runtime (unified chat + trigger engine + autonomy).

## Preconditions

- MongoDB cluster reachable from API.
- Oxy auth service reachable.
- Redis available if using queued agent sessions.
- Optional integrations/channels configured.

## Database Naming

Use per-app, per-env database naming:

- `clarity-development`
- `clarity-staging`
- `clarity-production`

Set database name via `mongoose.connect(..., { dbName })`.

## Minimum Environment (API)

```bash
PORT=8080
NODE_ENV=production
WEB_URL=https://clarity.oxy.so
API_BASE_URL=https://api.clarity.oxy.so
MONGODB_URI=<mongodb-uri>
JWT_SECRET=<strong-secret>
SERVICE_SECRET=<strong-secret>
OXY_API_URL=https://api.oxy.so
```

## Optional but Recommended

```bash
# Async queue
REDIS_URL=redis://...

# Integrations bridge
INTEGRATIONS_SERVICE_URL=https://integrations.clarity.oxy.so
INTEGRATIONS_SECRET=<shared-secret>

# Channels
TELEGRAM_BOT_SECRET=<secret>
DISCORD_BOT_SECRET=<secret>

# Sandbox runtime
DOCKER_HOST_URL=https://docker-host.clarity.oxy.so
DOCKER_HOST_SECRET=<secret>
```

## Model Routing Credentials

Configure internal model-routing credentials via environment variables required by your deployment policy and internal routing module. Do not expose routing internals in public clients.

## Startup Behavior

On API boot, the server automatically:

- Connects MongoDB.
- Initializes Socket.IO.
- Starts trigger scheduler (`/triggers` runtime).
- Starts async worker if queue is configured.
- Seeds built-in skills/suggestions/bots.
- Warms model-routing caches.

## Proactive Runtime

- Scheduled execution is trigger-native (`/triggers`).
- Startup loads and schedules enabled triggers automatically.

## Health Checks

- `GET /health`
- `GET /v1/models` (verifies auth + model abstraction path)

## Post-Deploy Validation

1. Chat stream works on `/v1/chat/completions`.
2. `clarity.plan_preview` SSE is emitted for stream requests with autonomy context.
3. Trigger create/run works via `/triggers`.
4. Oxy webhook accepts and deduplicates `eventId`.
5. Approval flow emits `clarity.approval_request/result` for `R2` actions.
6. Removed endpoints return `410` (`/v1/resolve-model`, `/v1/report-usage`, `/codea/resolve-model`, `/codea/report-usage`).

## Rollback Strategy

- Use deployment-level rollback (image/version).
- For runtime actions, `R1` writes are tracked in `RollbackRecord` with expiration window.

## Operational Notes

- Keep logs sanitized for user-facing surfaces.
- Do not expose internal model-routing details in public responses, docs, or audits.
