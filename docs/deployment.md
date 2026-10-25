# Deployment

The API deploys to AWS ECS Fargate in `us-west-2`, behind the shared Oxy ALB, from the
`linux/arm64` Dockerfile in `packages/api/`. `.github/workflows/deploy-aws.yml` builds,
pushes to ECR and rolls the service out once CI has passed on a push to `main`
(`workflow_run`, never in parallel with CI), authenticating with OIDC — there are no AWS
keys in this repository. Its `scope` job releases only main's current head, and only when
something other than Markdown or `docs/` changed since the last release;
`deploy-integrations.yml` and `deploy-frontends.yml` follow the same pattern with their own
path scopes (`.github/scripts/deploy-scope.sh`). `workflow_dispatch` releases main's head
on demand, and still requires CI to have succeeded for it.

Infrastructure — the task definition, the ALB, the target group, ECR, IAM and the SSM
parameter tree — is owned by `oxy-infra`, not by this repository. What lives here is the
image and the environment contract below. Runtime secret values live only in SSM (see
[Secrets](#secrets)).

**Runtime: Bun.** The image's runtime stage is `oven/bun:1.4.3-slim` (Debian), the same
pinned image the dependencies are installed with, and its CMD is
`bun packages/api/dist/index.js`. Every one-shot that overrides the command names `bun`
too: the pre-rollout migrator (`MIGRATION_RUNTIME: bun` in `deploy-aws.yml`, read by
`.github/scripts/deploy-ecs-image.sh`, whose default stays `node` for
`packages/integrations`, still on Node), the post-rollout migrator and seeder, and the
production chat canary. CI's `API image (Bun runtime)` job
boots the built arm64 image against Postgres (`.github/scripts/smoke-api-image.sh`), and
`src/__tests__/dockerfileRuntime.test.ts` holds the Dockerfile and those commands
together. To return to Node, revert the change that made the switch: it moved the
Dockerfile and every one of those commands at once, and they must stay together. The
computer host's control API (`packages/alia-computer-host/Dockerfile`) runs on Bun the
same way; its workspace image (actors' computers and the browser worker) stays on Node.
## Preconditions

- **PostgreSQL, reachable.** `DATABASE_URL` is required. `packages/api/src/index.ts:411`
  calls `connectPostgresOrExit()` before the server listens; without it the process exits.
- **Oxy identity service reachable** at `OXY_API_URL` for token verification.
- **Redis or Valkey, optional.** Without `REDIS_URL`, BullMQ tasks run inline and rate
  limiting fails open.

PostgreSQL is the only database precondition. See *Database* below.
- **Object storage, required for uploads.** S3 or a compatible endpoint.

## Database

**PostgreSQL** is the primary store: 80 tables under `packages/api/src/db/schema/`,
migrated by `packages/api/src/db/migrate.ts`, which requires an explicit
`--target-database` and honours `pre` / `post` phase markers. The deploy workflow runs the
migration; a zero-capacity deploy exits before the post-migration step, so a `post`
migration does not land on one.

PostgreSQL is the only store this service opens.
`packages/api/src/db/__tests__/bootWiring.test.ts` pins the boot wiring: the boot
guards run before the socket opens, and the expiry sweeper and background services
start unconditionally.

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
```

**Both services use attested workload identity.** The API and
`alia-integrations` exchange their temporary ECS task credentials for short-lived
Oxy service tokens. They use different registered workloads with explicit
environment and recipient binding; new producers use neither an Oxy client key
nor an internal shared secret. Phase B temporarily retains the existing secret
readers for drained-in-order A2 callers (see `process-reader-transition.md`). Local development uses the shared server-only AWS credential
provider with a temporary IAM/SSO development role registered in Oxy. A role's
environment comes from the server-owned binding, never a caller assertion.

Because a release renders from the task definition the service is already
RUNNING, removing the pair took an explicit entry in each lane's
`TASK_SECRET_REMOVALS_JSON`: deleting the lines that supplied it would have left
it inherited on every future revision. `alia-integrations` never had such a line
to delete — its pair comes from the task definition oxy-infra registered — which
is precisely why the removal list is the only lever there.

Alia's identity to Oxy is not an upstream provider credential either way.
Provider keys are absent from this contract and remain only in Kaana's
PostgreSQL/KMS custody.

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
ALIA_COMPUTER_HOST_URL=http://computer.alia.internal.oxy.so:8080  # agents' computer (no secret: workload identity)
ALIA_COMPUTER_HOST_INSTANCE_ID=i-...     # lets the API wake the host when it has stopped itself
SYRA_API_URL=https://api.syra.fm       # where a show series is published
```

The agents' computer host (`packages/alia-computer-host`) is not part of the API's
ECS service: it is one EC2 Spot instance (Fargate cannot run Docker or gVisor),
provisioned by `OxyHQ/oxy-infra` (`terraform-uswest2/alia-computer-host.tf`, runbook
`docs/runbooks/47-alia-computer-host.md`). Its two images (the control API and the
workspace/browser image) are released by `.github/workflows/deploy-computer-host.yml`,
`workflow_dispatch` only: it pushes them, records their digests in SSM and restarts the
host's unit over SSM Run Command. Without `ALIA_COMPUTER_HOST_URL` the API simply builds
no `computer` tools ([actors](./actors.mdx#the-agents-computer)).

`SYRA_API_URL` carries no secret and needs none: Syra authenticates the caller's
own Oxy token for everything a route does, and the background worker redeems a
single-use ingest ticket that the route minted while that token was live. There
is no service credential to hold, because service-token delegation is closed
platform-wide until ADR 0012 lands.

**Oxy Files** ([Alia on Oxy Files](./oxy-files.md)): `OXY_FILES_WEBHOOK_SECRET`
(SSM `/oxy/alia/OXY_FILES_WEBHOOK_SECRET`) is the `whsec_…` secret Oxy Console
shows once when the file-events endpoint `https://api.alia.onl/webhooks/oxy-files`
is registered; without it the route answers only the registration challenge (404 to everything else). Private content (library,
spoken clips, skill files) always goes to Oxy first — there is no switch — and
the backfill (`dist/scripts/migrate-to-oxy-files.js`) runs as an ECS one-shot;
`SYRA_COVER_FILE_IDS` stays unset until Syra is deployed with `imageFileId`
(Syra #214) and lists Alia in `SYRA_COVER_APPLICATION_IDS`.
Alia's Oxy application needs `files:app:write`, `files:app:delete`,
`files:references:write`, `files:read`, `files:linked:read` and
`files:user-media:write` (staff-granted).
`AWS_S3_BUCKET` stays until the bucket's retirement gate is met.

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

### Variables that must remain absent

`GATEWAY_API_URL` and every upstream-provider key variable must be unset. The
hosted runtime has one inference boundary, Kaana, and boot guards reject a task
that combines it with a direct-provider route. Provider credentials live only in
Kaana's encrypted database; they never live in Alia's environment or SSM tree.

### Hosted inference through Oxy

The configuration is all-or-nothing. There is no enable flag and no direct
provider or direct-Kaana fallback. Alia uses the published `OxyInferenceClient`;
Oxy derives principal IDs and authorised routes from the service token before
calling Kaana.

```bash
OXY_API_URL=https://api.oxy.so
```

The deployed process obtains temporary credentials from its task role. For
local development, use `AWS_PROFILE` with an authenticated IAM/SSO development
role through `createAwsWorkloadCredentialProvider()`; Oxy must have a live
binding for that exact role and development environment. Do not substitute a
customer API key. Boot checks the configured Oxy origin; the exchange validates
the role and live binding when a request is made. A healthy process alone is
not evidence that the workload can authenticate.

`OXY_API_URL` is pinned to `https://api.oxy.so` in deployed environments. Local
development may use loopback. Paths, query strings, embedded credentials,
scheme downgrades and near-miss origins are rejected. Alia does not configure a
Kaana URL, signing key, account/application/credential IDs or route list.

Own service callers do not request scopes. External API keys and external OAuth
connections retain their scoped authority; they are not a development fallback
for Alia's workload.

Merging this configuration does not prove production cutover. The rollout must
still verify the deployed Alia task revision, Oxy route and Kaana health, and
must census the live task definition for retired provider variables and direct
Kaana signing material.

Agents no longer store routing-profile IDs, so the former
`check-agent-routing-profile-readiness` gate has nothing to check: an agent or
thread stores a real `<publisher>/<model>` or `NULL`, and a model the catalogue
no longer carries falls back to the default at run time
([ADR 0012](./adr/0012-alia-uses-real-models.md)). What must be true before a
rollout is that Oxy returns a non-empty catalogue to the Alia application
(`GET /catalogue` lists at least one model).

### Secrets

SSM Parameter Store is the ONE source of every runtime secret: `/oxy/alia/<NAME>` and
`/oxy/alia-integrations/<NAME>` (`SecureString`), plus the oxy-infra-owned
`/oxy/_shared/*`. ECS injects them at task launch. GitHub holds none of them, and no
workflow writes one: `packages/api/src/db/__tests__/deployWorkflow.test.ts` fails if a
workflow writes a secret to SSM or reads a repo secret other than the job token and the
Cloudflare credentials `deploy-frontends.yml` spends. Until 2026-10-10 the API and
integrations deploys copied GitHub repo secrets into SSM on every run.

```bash
# set or rotate (the owner, never a workflow)
aws ssm put-parameter --profile oxy --region us-west-2 --type SecureString \
  --overwrite --name /oxy/alia/VAPID_PRIVATE_KEY --value '…'
# then roll the service so new tasks read it
aws ecs update-service --profile oxy --region us-west-2 --cluster oxy-cluster \
  --service alia --force-new-deployment
```

A NEW secret is written to SSM FIRST and only then bound in the task definition: a task
naming a parameter that does not exist registers fine and then cannot start. The full
procedure is oxy-infra `docs/runbooks/46-app-secrets-in-ssm.md`.

`GITHUB_TOKEN` (optional, a read-only fine-grained token for public repositories) is read
by the skill registry sync and skill imports (`lib/skills/github.ts`). Without it GitHub
allows 60 requests an hour per shared egress address; the sync copes anyway (stored ETags
in `skill_registry_sync_state`, 304 for an unchanged repository, `Retry-After` honoured,
last good catalogue kept), but a token is the fix for the quota itself. It does not exist
in `/oxy/alia/` today: the owner creates the parameter first, then binds it in the task
definition, per the order above.

`/oxy/alia/TOKEN_ENCRYPTION_KEY` is shared by the API and integrations, so
rotation must re-encrypt stored rows and roll both processes. Authentication
between those processes uses the shared `@alia.onl/server/internal` workload
transport with the exact receiving process identity. `SERVICE_SECRET`,
`INTEGRATIONS_SECRET` and the retired Oxy key pair are explicitly removed through
`TASK_SECRET_REMOVALS_JSON`; merely deleting an input would leave a live inherited
secret in place. The phase-C release is allowed only after both phase-B processes
are verified live and their previous tasks have drained. Remove the corresponding
SSM parameters only after the coordinated rollout and live readback prove that
no task still uses them.

Own tool access comes from the verified requester or durable task, plus live
account/resource checks. Workload scopes do not enable own app tools.

## Startup behaviour

On boot, in this order (`packages/api/src/index.ts`, from `connectPostgresOrExit()` to the
end of the `server.listen` callback — named rather than cited by line, because a line
number in a document drifts with every edit above it):

1. Connect to PostgreSQL, or exit.
2. Check the complete Oxy inference SDK configuration, or exit — see *Hosted
   inference through Oxy* above. There is no partial/direct-provider mode.
3. Start listening. Nothing below blocks the listener.
4. Start the expiry sweeper, which deletes rows whose retention has passed. It depends only
   on PostgreSQL.
5. Start the background services — the trigger engine, the moderation-outbox dispatcher,
   and both queues — unconditionally. Each one self-gates on the dependency it actually
   reads.
6. Check Redis connectivity asynchronously; without `REDIS_URL`, rate limiting
   is disabled and the service records that state without inventing another
   inference path.

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
2. `GET /catalogue` lists real `<publisher>/<model>` entries with a
   `defaultModelId`, and a chat stream works on `POST /v1/chat/completions`
   without a `model`.
3. `GET /v1/models` returns the same models in the OpenAI-compatible shape.
4. Automation create and manual run work via `/automations`.
5. `POST /webhooks/oxy` accepts a normalized event from an authorized Oxy service and
   deduplicates on `(appId, eventId)`; `POST /webhooks/oxy/:serviceId` returns `410`.
6. The two removed model-resolution endpoints return `410`: `/v1/resolve-model`,
   `/v1/report-usage`. The whole `/codea` router is gone (it served only the retired
   `alia_sk_*` keys) and answers `404`.

## Rollback

- Roll the ECS service back to the previous task definition revision. Across the
  2026-10 Node-to-Bun switch this is safe in both directions for the service itself:
  each revision carries its own image and CMD. The live-image one-shot
  (`production-chat-canary.yml`) names `bun`, so
  against a pre-switch Node revision its task fails to start until a Bun image serves. A revision that was
  registered but never rolled out is invisible to the next deploy, which derives its
  revision from the one the service is running.
- For runtime actions rather than deploys, `R1` writes leave a `rollback_records` row with
  an expiry window.

## Operational notes

- Keep logs sanitized on customer-facing surfaces. `sanitizeMessage()` is the chokepoint.
- Do not expose upstream routing detail in product responses. Kaana owns provider
  deployment, retry and health telemetry; Alia logs only the Kaana request/result
  identifiers needed to correlate a product failure.
- Each successfully delivered, non-cancelled hosted turn emits exactly
  `Alia functional turn completed` with no attached request, account, model or provider
  fields. Failed turns and a `ServerResponse` that closes before `writableEnded` emit no
  success marker; a normal response close does not masquerade as cancellation. The public status alarm combines
  that positive marker with the existing capability-loading and Kaana-inference failure
  chokepoints. It creates no synthetic inference: silence is unknown, never success.

### Auditing a change to plan configuration

Alia keeps no model configuration: models come from Oxy's catalogue and
`plans.model_ids` is dropped (ADR 0012). Every write to `plans` emits a structured record on the `config-audit`
subsystem, from inside the repository function rather than from a caller — so any future
caller is audited without being changed
(`packages/api/src/lib/security/config-audit.ts`). In CloudWatch:

```
{ $.subsystem = "config-audit" && $.event = "config.change" }
```

Each record carries `resource`, `action`, `target`, `actor`, `before`, `after` and `at`.
It deliberately carries no prompt, response content or credential. Alia has no hosted
provider-key writer to audit; Kaana owns that administrative trail.


### Clarity client and catalogue contracts

Alia uses `clarityForOxyService` from `@clarity.surf/sdk/server` (SDK 0.10 or
later). The product SDK supplies Clarity's canonical audience and delegates
minting, refresh and origin protection to the shared Oxy service transport.
`CLARITY_API_URL` selects the endpoint; it does not select the audience or
provide a credential. The client is disposed during graceful shutdown.
Deploy the matching Clarity receiver before activating this producer.

Oxy contracts 6 validates catalogue actor declarations directly. Alia no longer
strips and restores actor fields for pre-4.11 contracts. The registered catalogue
and its digest remain intact; requester and bot accounts stay separate.


## Codea and Cowork desktop artifacts

`alia-codea` and `alia-cowork` are private workspace packages. The npm release
workflow does not publish them, and the repository currently has no Marketplace
or Electron distribution workflow. A successful main CI or Alia backend rollout
therefore does not mean these desktop versions reached users.

After the matching Alia API rollout is verified, produce Codea's VSIX with
`bun run --cwd packages/alia-codea package`. Its manifest version is the extension
version. The web and Node bundles are built together; local workspace tools
still require their supported extension host capabilities.

Cowork uses `bun run --cwd packages/alia-cowork dist`, with `publish: null` and
`--publish never`. Build each supported OS/architecture on a suitable runner.
Unsigned Linux artifacts establish packaging only; Windows/macOS signing,
notarization and the chosen download/store channel require separate configured
release automation. Do not report those distributions as complete from an
unsigned local build. Signing-in on an installed desktop app is a separate
acceptance check from unit tests and artifact creation.
