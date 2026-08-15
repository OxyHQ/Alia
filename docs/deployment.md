# Deployment

The API deploys to AWS ECS Fargate in `us-west-2`, behind the shared Oxy ALB, from the
`linux/arm64` Dockerfile in `packages/api/`. `.github/workflows/deploy-aws.yml` builds,
pushes to ECR and rolls the service out on a push to `main`, authenticating with OIDC —
there are no AWS keys in this repository.

Infrastructure — the task definition, the ALB, the target group, ECR, IAM and the SSM
parameter tree — is owned by `oxy-infra`, not by this repository. What lives here is the
image, the environment contract below, and the secret allow-list in the deploy workflow.

## Preconditions

- **PostgreSQL, reachable.** `DATABASE_URL` is required. `packages/api/src/index.ts:411`
  calls `connectPostgresOrExit()` before the server listens; without it the process exits.
- **Oxy identity service reachable** at `OXY_API_URL` for token verification.
- **MongoDB, only for the domains not yet ported.** The connection is attempted in the
  background with retry (`index.ts:381`) and the HTTP server starts regardless. Routes
  backed by a Mongoose model return `500` while it is unreachable; every ported route
  serves normally.
- **Redis or Valkey, optional.** Without `REDIS_URL`, BullMQ tasks run inline and rate
  limiting fails open.
- **Object storage, required for uploads.** S3 or a compatible endpoint.

## Database

**PostgreSQL** is the primary store: 80 tables under `packages/api/src/db/schema/`,
migrated by `packages/api/src/db/migrate.ts`, which requires an explicit
`--target-database` and honours `pre` / `post` phase markers. The deploy workflow runs the
migration; a zero-capacity deploy exits before the post-migration step, so a `post`
migration does not land on one.

**MongoDB**, where still used, takes its database name from `NODE_ENV` as
`alia-{NODE_ENV}` and passes it as `dbName` to `mongoose.connect()`
(`packages/api/src/lib/db.ts:60`). Never embed the database name in `MONGODB_URI`.

## Environment

`packages/api/.env.example` is the full contract with per-variable notes. The minimum for a
production API:

```bash
PORT=3001
NODE_ENV=production
WEB_URL=https://alia.onl
API_BASE_URL=https://api.alia.onl
OXY_API_URL=https://api.oxy.so
DATABASE_URL=<postgres-connection-string>
SERVICE_SECRET=<32-byte hex>
```

`PORT` has no correct default to rely on: `packages/api/src/index.ts:93` falls back to
`4150`, while the container's health check and `EXPOSE` use `3001`
(`packages/api/Dockerfile:125`). Set it explicitly.

Recommended, each disabling a feature when absent rather than blocking boot:

```bash
REDIS_URL=rediss://...                 # BullMQ, rate limiting, Socket.IO adapter
TOKEN_ENCRYPTION_KEY=<32-byte hex>     # encrypts stored OAuth and bot tokens
INTEGRATIONS_URL=https://...           # MCP tools and channel proxy
INTEGRATIONS_SECRET=<32-byte hex>
DOCKER_HOST_URL=https://...            # agent container sandbox
DOCKER_HOST_SECRET=<32-byte hex>
MONGODB_URI=<mongodb-connection-string>
```

`TOKEN_ENCRYPTION_KEY` must be the **same value** in the API and the integrations service:
encrypted tokens are written by one process and read by the other.

### Two variables that are not what they look like

- **`GATEWAY_API_URL`.** Setting it *and* `SERVICE_SECRET` flips
  `packages/api/src/lib/gateway-client.ts:32` into remote mode and every provider call goes
  to an HTTP service that no longer exists. `packages/alia-gateway` was deleted. Leave
  `GATEWAY_API_URL` unset. It is still read by
  `packages/api/src/lib/tools/gateway-admin.ts`, which is why it has not been deleted
  outright; removing it is part of workstreams 8 and 9 of #139.
- **`GROK_API_KEY`.** Its only reader is
  `packages/api/src/internal/providers/lib/providers/grok-voice.ts:52`, in the expression
  `!!process.env.GROK_API_KEY || true`, which is true either way. It changes nothing.
  Upstream credentials live in the `provider_keys` table, not in the environment.

### Secrets

GitHub Actions repository secrets are the source of truth. The deploy workflow syncs an
explicitly enumerated list into SSM under `/oxy/alia/*` and `/oxy/_shared/*`
(`.github/workflows/deploy-aws.yml:65` onward), and ECS injects them at task launch. The
list is enumerated one secret at a time on purpose: a workflow that walks the whole
`secrets` context is shaped like an exfiltration payload and makes every run wait for
human approval. **Adding a new secret means adding it to that list, or it never reaches
SSM.**

Never set a repository secret to a placeholder. The sync job overwrites the real value.

## Startup behaviour

On boot, in this order (`packages/api/src/index.ts:411` onward):

1. Connect to PostgreSQL, or exit.
2. Start listening. Nothing below blocks the listener.
3. Start the expiry sweeper, which deletes rows whose retention has passed. It depends only
   on PostgreSQL.
4. Attempt the MongoDB connection with backoff. Background services that read Mongoose
   models — the trigger scheduler, the moderation outbox dispatcher, the queues and the
   built-in seeds — start only once that connection succeeds.
5. Pre-warm TLS connections to upstream endpoints.

## Health checks

| Route | Answers | Use it for |
|---|---|---|
| `GET /health/live` | "Is this process running." Consults no dependency | Liveness probe |
| `GET /health/ready` | "Can this task serve traffic." Runs `select 1` against PostgreSQL | Readiness probe, and the ALB target group |
| `GET /health` | Detailed snapshot, cached 10s | Operators |

A liveness probe that fails on a database blip gets the task killed and replaced, which is
the worst response to a brief outage — that is why `/health/live` is unconditional.

`packages/api/src/routes/health.ts:28` records that the `oxy-alia` target group
health-checks `/health/live`, so a task whose database is unreachable is still marked
healthy and still receives traffic. Moving the target group to `/health/ready` is an
`oxy-infra` change and must happen before this service is scaled up again.

## Post-deploy validation

1. `GET /health/ready` returns ready.
2. A chat stream works on `POST /v1/chat/completions`.
3. `GET /v1/models` lists the Alia identifiers.
4. Trigger create and run work via `/triggers`.
5. `POST /webhooks/oxy/:serviceId` accepts an event and deduplicates on `eventId`.
6. The four removed endpoints return `410`: `/v1/resolve-model`, `/v1/report-usage`,
   `/codea/resolve-model`, `/codea/report-usage`.

## Rollback

- Roll the ECS service back to the previous task definition revision. A revision that was
  registered but never rolled out is invisible to the next deploy, which derives its
  revision from the one the service is running.
- For runtime actions rather than deploys, `R1` writes leave a `rollback_records` row with
  an expiry window.

## Operational notes

- Keep logs sanitized on customer-facing surfaces. `sanitizeMessage()` is the chokepoint.
- Do not expose upstream routing detail in product responses, docs or audits. The scope of
  that rule is in [model abstraction](./model-abstraction.mdx).

## Open questions

- **`.do/app.yaml` is stale.** It describes a DigitalOcean App Platform deployment with a
  `gateway` service built from `bun run build:gateway`, a script that no longer exists, and
  points `GATEWAY_API_URL` at it. Whether to delete it or keep it as a historical record is
  not decided here. *Owner: the #139 epic owner, with `oxy-infra`.*
