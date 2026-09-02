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
- **Redis or Valkey, optional.** Without `REDIS_URL`, BullMQ tasks run inline and rate
  limiting fails open.

There is no MongoDB precondition. See *Database* below.
- **Object storage, required for uploads.** S3 or a compatible endpoint.

## Database

**PostgreSQL** is the primary store: 80 tables under `packages/api/src/db/schema/`,
migrated by `packages/api/src/db/migrate.ts`, which requires an explicit
`--target-database` and honours `pre` / `post` phase markers. The deploy workflow runs the
migration; a zero-capacity deploy exits before the post-migration step, so a `post`
migration does not land on one.

MongoDB is not part of this service. `lib/db.ts`, the boot-time `connectDB()` and
the last backup-only operator script are deleted; no Mongoose model is
registered and no Mongo driver is declared. The old script could not reach the
destroyed source database and was not a restore or backfill path.

`packages/api/src/db/__tests__/bootWiring.test.ts` asserts the boundary twice:
it walks the import graph from `src/index.ts`, and it scans every tracked source
file plus the package manifest for either Mongo driver. The first protects a
request in production; the second catches a model declared today and routed
next week. The pre-drop archive is external retention data and was not modified
by this repository cleanup.

The `integrations` service is a separate process with its own manifest.

## Environment

`packages/api/.env.example` is the full contract with per-variable notes. The minimum for a
production API:

```bash
PORT=3001
NODE_ENV=production
WEB_URL=https://alia.onl
API_BASE_URL=https://api.alia.onl
ALIA_API_URL=https://api.alia.onl
OXY_API_URL=https://api.oxy.so
DATABASE_URL=<postgres-connection-string>
SERVICE_SECRET=<32-byte hex>
```

Terraform declares both public-origin names, while `deploy-aws.yml` re-asserts
them through `TASK_ENV_OVERRIDES_JSON` on every runnable revision. The split is
required because the existing ECS service ignores Terraform task-definition
changes. `API_BASE_URL` advertises callbacks and webhooks; `ALIA_API_URL` also
builds user-facing links and service-to-self `/v1` requests, so neither may fall
back to loopback in production.

`PORT` has no correct default to rely on: `packages/api/src/index.ts:93` falls back to
`4150`, while the container's health check and `EXPOSE` use `3001`
(`packages/api/Dockerfile:125`). Set it explicitly.

Recommended, each disabling a feature when absent rather than blocking boot:

```bash
REDIS_URL=rediss://...                 # BullMQ, rate limiting, Socket.IO adapter
TOKEN_ENCRYPTION_KEY=<32-byte hex>     # see below — NOT optional for shows
INTEGRATIONS_URL=https://...           # MCP tools and channel proxy
INTEGRATIONS_SECRET=<32-byte hex>
DOCKER_HOST_URL=https://...            # agent container sandbox
DOCKER_HOST_SECRET=<32-byte hex>
SYRA_API_URL=https://api.syra.fm       # where a show series is published
```

`SYRA_API_URL` carries no secret and needs none: Syra authenticates the caller's
own Oxy token for everything a route does, and the background worker redeems a
single-use ingest ticket that the route minted while that token was live. There
is no service credential to hold, because service-token delegation is closed
platform-wide until ADR 0012 lands.

**One prerequisite lives in SYRA, not here.** Web playback fetches an episode's
audio from `api.syra.fm` with the listener's bearer token, so Alia's web origin
must be in Syra's CORS allow-list (`packages/backend/server.ts`, `ALLOWED_ORIGINS`).
Native has no CORS and is unaffected. Until that is set, episodes play on iOS and
Android and fail in a browser.

### `TOKEN_ENCRYPTION_KEY` is listed above but is REQUIRED for shows

It is in the recommended block because its absence does not block boot, and that
much is still true. The rest of that heading is not: it does not degrade a
feature, it **throws**.

`encryptedText` (`db/schema/columns.ts`) applies `encrypt` to every write drizzle
builds, and `crypto-utils.ts` throws when the key is absent or is not 64 hex
characters. The columns that use it are the OAuth access and refresh tokens on
`integrations` and on `connected_accounts`, `bots.bot_token`, and
`show_episodes.ingest_ticket` — enumerated rather than counted, so the list
cannot drift from a number beside it.

That last one is on the CREATE path, not a background one. Without the key,
`POST /shows/series/:id/episodes` fails at the insert, after the Syra episode has
already been drafted, and answers a sanitized 500 that names nothing —
**an operator reading it has no reason to suspect a missing variable.** Listing
and reading shows keep working, because the route-facing queries name their
columns and leave the ticket out; only creating an episode fails.

**Rotating the key breaks whatever is in flight.** A ticket encrypted under the
old key cannot be read under the new one, and the read fails rather than
returning a wrong value, so every queued episode fails at the point the worker
loads it. The blast radius is bounded and self-clearing: tickets are single-use
and Syra mints them with a 24-hour TTL (`INGEST_TICKET_TTL_SEC`), so the damage
is the episodes queued at the moment of rotation and nothing older. Drain the
show queue before rotating, or accept that those episodes need starting again.

It must also be the **same value** in the API and the integrations service:
encrypted tokens are written by one process and read by the other.

### Two variables that are not what they look like

- **`GATEWAY_API_URL`.** Setting it *and* `SERVICE_SECRET` flips
  `packages/api/src/lib/gateway-client.ts:32` into remote mode and every provider call goes
  to an HTTP service that no longer exists. `packages/alia-gateway` was deleted. Leave
  `GATEWAY_API_URL` unset. Its second reader, `packages/api/src/lib/tools/gateway-admin.ts`,
  was deleted by workstream 9 of #139 — an AI-callable tool that proxied provider-key CRUD
  to `${GATEWAY_API_URL}/gateway/v1/*`, endpoints that had ceased to exist. One reader
  remains, `gateway-client.ts` itself, so the variable retires with that seam
  (workstream 8), not before.
- **`GROK_API_KEY`.** Removed from `packages/api/.env.example`; documented here so nobody
  puts it back. Its only reader is
  `packages/api/src/internal/providers/lib/providers/grok-voice.ts:52`, in the expression
  `!!process.env.GROK_API_KEY || true`, which is true either way — and that read never
  executes at all: `isEnabled` has 24 definitions under `packages/api/src` and zero call
  sites repo-wide. Upstream credentials live in the `provider_keys` table, not in the
  environment.

### Kaana client migration state

The only canonical signed Kaana origin is `https://kaana.ai`. Current `main` has not
completed that identity cut: its dormant client still uses the legacy variable names
below, and `KAANA_ALLOWED_ORIGINS` still names `api.oxy.so` plus the obsolete
`relay.oxy.so` data-plane origin rather than the canonical apex. This section documents
the code that exists; it is not an instruction to enable that legacy route or a claim
that production has cut over.

The legacy variables are **all or nothing**: when `ALIA_RELAY_CLIENT_ENABLED` is exactly
the literal `true`, the process refuses to start unless the other values describe a
principal `@oxyhq/contracts` accepts and an origin permitted by the current source
(`packages/api/src/lib/inference/kaana-boot-check.ts`).

```bash
ALIA_RELAY_CLIENT_ENABLED=true        # exactly `true`; `1` and `TRUE` do not enable it
ALIA_RELAY_ACCOUNT_ID=<oxy-account>   # who is charged; never an end user
ALIA_RELAY_APPLICATION_ID=<oxy-app>
ALIA_RELAY_CREDENTIAL_ID=<oxy-credential>
ALIA_RELAY_ENVIRONMENT=production     # development | staging | production
ALIA_RELAY_INFERENCE_SCOPES=inference:invoke
RELAY_BASE_URL=https://api.oxy.so     # legacy variable; current Oxy-edge route only
```

`ALIA_RELAY_ENVIRONMENT` is the environment the **credential** was issued into, and on a
production or staging task it must match `NODE_ENV`: a staging credential presented by a
production task bills test traffic to the production account, and no later query separates
it out again. A development process is left alone, so a local run may point wherever it was
configured.

`RELAY_BASE_URL` is **pinned to the current source allow-list**, not merely read
(`packages/api/src/lib/inference/kaana-endpoint.ts`, `KAANA_ALLOWED_ORIGINS`). A production
or staging process accepts only an origin in that list and refuses to start on anything
else — a near miss such as `https://api.oxy.so.example`, a scheme downgrade, a URL carrying
credentials, and loopback are all refused. A **development** process may additionally point
at `localhost` or `127.0.0.1`; that is the only relaxation, it is keyed on `NODE_ENV`, and
there is deliberately no variable that widens the list. The client re-checks the value on
every call as well, so a configuration mutated after boot cannot ride a boot-time approval.
The remaining legacy origin must be removed by the coordinated identity cut; do not add a
new alias or treat it as a supported Kaana hostname.

Deliberately absent from `.do/app.yaml` and from `deploy-aws.yml`'s secret list. Adding
them there before `Oxy API → Kaana` is mounted would be configuration for a service that
does not answer; adding them is part of the #139 workstream 8 cutover, together with
flipping the flag.

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

On boot, in this order (`packages/api/src/index.ts`, from `connectPostgresOrExit()` to the
end of the `server.listen` callback — named rather than cited by line, because a line
number in a document drifts with every edit above it):

1. Connect to PostgreSQL, or exit.
2. Check the Kaana client configuration, or exit — see
   *Kaana client* below. A no-op unless `ALIA_RELAY_CLIENT_ENABLED` is exactly `true`.
3. Start listening. Nothing below blocks the listener.
4. Start the expiry sweeper, which deletes rows whose retention has passed. It depends only
   on PostgreSQL.
5. Start the background services — the trigger engine, the moderation-outbox dispatcher,
   both queues and the container pool — unconditionally. These were gated on a MongoDB
   connection resolving, which after the decommission it never did, so none of them had run
   in production since; the gate is gone rather than relaxed, and each one self-gates on the
   dependency it actually reads.
6. Pre-warm TLS connections to upstream endpoints.

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
- Do not expose upstream routing detail in product responses. Operator surfaces are the
  opposite case: a log, an audit record and a `fallback_events` row must name the
  deployment that failed, or the question they exist to answer cannot be asked. The scope
  is in [model abstraction](./model-abstraction.mdx).

### Auditing a change to model or routing configuration

Every write to `alia_models`, `alia_model_provider_mappings`, `model_configs`,
`provider_keys` or `external_models` emits a structured record on the `config-audit`
subsystem, from inside the repository function rather than from a caller — so any future
caller is audited without being changed
(`packages/api/src/lib/security/config-audit.ts`). In CloudWatch:

```
{ $.subsystem = "config-audit" && $.event = "config.change" }
```

Each record carries `resource`, `action`, `target`, `actor`, `before`, `after` and `at`.
Two things it deliberately never carries, both enforced by an allow-list rather than by
care: **no prompt or response content**, and **no credential** — `provider_keys.key` and
`key_hash` are excluded, and `key_prefix` is the identifier a record names a key by, the
same form [credential-rotation](./runbooks/credential-rotation.md) matches rows on.

Automatic key health — a cooldown, a failure run, a credit exhaustion — is **not** here.
Nobody configured it; it is a metric, and `lib/observability/metrics.ts` is where it
belongs. `packages/api/src/lib/security/__tests__/config-audit.test.ts` derives the writer
list from what each function does to those five tables rather than from its name, so a new
writer that emits nothing fails the build.

## Open questions

- **`.do/app.yaml` is stale.** It describes a DigitalOcean App Platform deployment with a
  `gateway` service built from `bun run build:gateway`, a script that no longer exists, and
  points `GATEWAY_API_URL` at it. Whether to delete it or keep it as a historical record is
  not decided here. *Owner: the #139 epic owner, with `oxy-infra`.*
