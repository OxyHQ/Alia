# Runbook: bringing the integrations service into production

`packages/integrations` is a deployed service in every sense except that it has
never been deployed anywhere. This is the DELIVERY runbook for changing that: the
order to do it in, what each step buys, and what breaks if two of them are
swapped.

It is a sibling of [`kaana-cutover.md`](./kaana-cutover.md) and inherits its
central trap — **Terraform cannot deliver a variable to a service that already
exists, and it fails silently.** The twist here is that half of this rollout is a
service that does NOT exist yet, where Terraform delivers everything, and the
other half is `alia`, where it delivers nothing.

**Never print, echo, log or write the value of `INTEGRATIONS_SECRET`,
`TOKEN_ENCRYPTION_KEY` or the integrations `DATABASE_URL`** — not to a file, a PR
body, a commit message or a job log. Every command below moves them without
rendering them.

---

## What is broken today, precisely

Measured on `oxy-alia:114`, the revision production runs: it carries seven
environment variables and ten secrets, and **neither `INTEGRATIONS_URL` nor
`INTEGRATIONS_SECRET` is among them.**

`packages/api/src/lib/tools/mcp.ts:48` reads:

```ts
if (INTEGRATIONS_URL && INTEGRATIONS_SECRET) {
```

That is false in production, so `buildMcpTools` skips the hosted branch entirely
and returns whatever local tools exist. There is no error and no log line.

Be precise about which things this breaks, because two of them look alike:

| | state | why |
| --- | --- | --- |
| **Hosted MCP connectors** | **inert** | the registry, `POST /mcp/install`, `POST /mcp/oauth/complete` and every tool call proxy to the integrations service |
| **Local MCP** | **working** | served by the API's own WebSocket bridge, `packages/api/src/lib/mcp-relay.ts`, for a server running on the user's own machine. It never touches this service |
| **Telegram/Discord bot command menus** | **frozen** | `setMyCommands` runs in this service's adapter init and Telegram persists the menu server-side, so it still holds whatever was written the last time the service ran anywhere |
| **Every fix merged into `packages/integrations`** | **undeliverable** | including the Mongo-to-Postgres port |

The bot menus stay frozen after this rollout, and that is worth stating plainly:
the Telegram and Discord adapters each self-skip unless their token is present
(`index.ts` gates them on `TELEGRAM_BOT_TOKEN` / `DISCORD_BOT_TOKEN`), and
neither token is in SSM. Unfreezing the menus is a separate change that needs a
credential this rollout does not provide.

## The four hops, and which of them Terraform can do

A variable reaches a container through the same layers `oxy-infra`'s runbook 30
describes, and this rollout hits **both** answers to "can Terraform deliver it":

| target | delivered by | can Terraform do it? |
| --- | --- | --- |
| `alia-integrations` env + secrets | Terraform, at service CREATION | **yes** — `ignore_changes` has nothing to ignore on a resource being created, so the service is created pointing at the revision the apply registers |
| `alia`'s `INTEGRATIONS_URL` | `TASK_ENV_OVERRIDES_JSON` in `deploy-aws.yml` | **no** |
| `alia`'s `INTEGRATIONS_SECRET` binding | `TASK_SECRET_OVERRIDES_JSON` in `deploy-aws.yml` | **no** |
| any SSM parameter's VALUE | the `Sync GitHub secrets -> SSM` step, every deploy | n/a |

The "no" rows are the whole reason this file exists.
`oxy-infra/terraform-uswest2/modules/app-service/main.tf` carries
`ignore_changes = [task_definition]`, so the `alia` service never adopts the
revision an apply registers; and `deploy-ecs-image.sh` bases each new revision on
`services[0].taskDefinition` — the revision currently RUNNING — so the CI chain
never inherits Terraform's either. A line added to that module block lands in a
revision nothing runs and nothing inherits, indefinitely and with no error.

Declaring them in `oxy-infra` is still correct and is done: a file that omits a
variable production needs misleads whoever reads it next. It is simply not a
rollout.

**What is different from the Kaana cutover:** that one delivered its seven plain
variables by hand, because no CI mechanism existed. This one adds the mechanism
the Kaana runbook named as the durable fix — `TASK_ENV_OVERRIDES_JSON`, mirroring
the secrets hook — so nothing here needs a hand-registered revision, and an
override survives a circuit-breaker rollback because it is re-asserted on every
deploy.

## Its own database, and why that is not negotiable

`alia_integrations`, a separate logical database on the shared `oxy-postgres`.
Underscores because an unquoted PostgreSQL identifier cannot contain a hyphen;
the ECS service and ECR repository are `alia-integrations`.

`@oxyhq/db` fixes the applied-migration ledger at `drizzle.__drizzle_migrations`
with no per-service namespacing, and applies a migration only when its journal
`when` is strictly newer than the newest recorded one. Two packages migrating
into one database therefore share one high-water mark.

The numbers, because this one is easy to wave away: `packages/integrations`' only
migration carries `when=1786270502993`. The **oldest** of `packages/api`'s 28 is
`1786313719561`. Every API migration is newer than the integrations one, so in a
shared `alia` database this migrator would find a ledger already past its entry
and `planLedgerRun` would throw `UnreachableMigrationError`.

That failure is loud, which is the good case. The bad case is the repair that
suggests itself — regenerate the migration with a newer `when` — which makes it
apply and then strands the API's next migration in exactly the same way, forever.

The table names do not collide (`mcp_connector_auths`, `whatsapp_*`,
`telegram_*`, `signal_*` here; `mcp_servers`, `mcp_oauth_states`, `integrations`
there), which is what makes a shared database look safe right up to the ledger.

`packages/integrations/src/db/__tests__/deployWiring.test.ts` gates the two
workflows naming different `--target-database` values.

## The secrets, and what each one is

| name | where the value lives | note |
| --- | --- | --- |
| `INTEGRATIONS_SECRET` | **create** as a repo secret in `OxyHQ/Alia`; 32 random bytes as hex | Read by BOTH services from ONE parameter, `/oxy/alia/INTEGRATIONS_SECRET`. The API sends it as `X-Gateway-Secret`; integrations compares it with `verifySecret`. Two parameters holding "the same" secret is one rotation away from a 401 nobody can explain |
| `TOKEN_ENCRYPTION_KEY` | already a repo secret, already at `/oxy/alia/TOKEN_ENCRYPTION_KEY` | Nothing to do. Both services read the SAME parameter — see below for why that matters more than it appears to |
| `DATABASE_URL` (integrations) | **SSM only**, written by hand at `/oxy/alia-integrations/DATABASE_URL` | Deliberately NOT a GitHub secret and deliberately NOT synced. See below |

### `TOKEN_ENCRYPTION_KEY`: the usual reason is not the true one

It is commonly stated that the two processes must share this key because
encrypted OAuth tokens are written by one and read by the other. That is not what
happens. `mcp_connector_auths` is written and read by the integrations process
ONLY — `packages/api` owns no such table and reaches MCP over HTTP — so no
ciphertext crosses the process boundary today. `packages/integrations/src/mcp/oauth-store.ts`
says so in its own header.

What makes sharing the key correct is that **the rows persist**. A service
redeployed under a different key cannot decrypt any connector a user authorised
before the change, and each one fails as an authorization error rather than a
decryption one — so the symptom points at the connector, not at the key. Both
services reading one SSM parameter makes that divergence unrepresentable, which
is why the terraform declares it that way rather than minting a second key.

### The integrations `DATABASE_URL` has no sync line, on purpose

`oxy-infra`'s runbook 30 §6 names this shape: a credential the provisioning
runbook generates rather than one typed into the GitHub UI has **SSM as its only
copy**. A sync line for it would be a loaded gun — the day somebody creates a
`DATABASE_URL` repo secret in `OxyHQ/Alia` for any reason, the next deploy
overwrites the only copy of the connection string with it, silently.

`/oxy/alia/DATABASE_URL` is already the same shape, and CrowdSource was
provisioned SSM-only for exactly this reason.

**Never set any of these to a placeholder.** `sync_secret` skips an empty value
or a literal `-` with a `::warning::` and leaves SSM unchanged, and the three ways
that bites are all quiet:

- **`-` or empty, parameter absent:** the sync is skipped, the deploy is **green**,
  and the next task launch fails with `ResourceInitializationError: unable to
  pull secrets`. The green deploy is the misleading part.
- **`-` or empty, parameter present:** the sync is skipped and the OLD value
  silently remains. Nothing reports that the rotation did not happen.
- **A real-looking placeholder (`TODO`, `changeme`):** no guard catches it. It is
  written and injected, and integrations rejects every API call with 401.

If you do not have the real value yet, do not create the secret at all.

---

## Order of operations

Six steps. Steps 1–4 leave production behaving exactly as it does today; step 6
is the only one that changes what the API does.

### 1. Provision the database (oxy-infra runbook 30 §2)

As `oxyadmin`: `CREATE ROLE alia_integrations LOGIN PASSWORD …`, `GRANT
alia_integrations TO oxyadmin`, `CREATE DATABASE alia_integrations OWNER
alia_integrations`, `REVOKE alia_integrations FROM oxyadmin`. Then write
`/oxy/alia-integrations/DATABASE_URL` to SSM as a `SecureString`, pointing at
`postgres.internal.oxy.so:5432/alia_integrations?sslmode=require`.

**Before step 3, not after.** The task definition an apply creates names that
parameter, and unlike a module-backed service this one adopts its revision at
creation — so a missing parameter is not latent here, it crash-loops every task
with `ResourceInitializationError` behind a green apply.

### 2. Create the `INTEGRATIONS_SECRET` repo secret in `OxyHQ/Alia`

`gh secret set INTEGRATIONS_SECRET` reading from stdin, never as a command-line
argument. Nothing consumes it yet: `deploy-aws.yml` syncs it to SSM and, seeing
it present, will bind it on the API — which is harmless, because the API's
hosted-MCP branch also needs `INTEGRATIONS_URL`, which is still unset.

### 3. Apply the oxy-infra terraform

Creates the ECR repository, the ECS service and its task definition, the Cloud
Map namespace and service, the security group, and adds `alia-integrations` to
the deploy role's ECR-push allow-list.

**Expect a few minutes of `CannotPullContainerError`.** The service is created
pointing at `oxy/alia-integrations:latest` and no image exists yet. ECS retries
with backoff; nothing depends on the service, so nothing is affected. It clears
itself at step 4.

The ECR-push allow-list is why this cannot be swapped with step 4: it is an
explicit list of repository ARNs, and `alia-integrations` missing from it fails
the push with `AccessDenied` **after** a full ARM64 build of a Chromium image.

### 4. Merge the Alia PR

`deploy-integrations.yml` builds and pushes the image, then — because the service
now exists and is ACTIVE — runs the migration one-shot on the NEW task
definition, and only on success repoints the service.

`deploy-aws.yml` also runs, and produces a task definition identical to today's
apart from the `INTEGRATIONS_SECRET` binding. The API's behaviour is unchanged.

### 5. Verify before arming anything

```bash
aws --profile oxy --region us-west-2 ecs describe-services \
  --cluster oxy-cluster --services alia-integrations \
  --query 'services[0].{td:taskDefinition,desired:desiredCount,running:runningCount}'
```

Assert `running == desired == 1` and note the revision. **`rolloutState:
COMPLETED` alone is vacuous** — a service parked at zero reaches it immediately
with nothing running — so check the counts separately.

Then confirm the service answers on its private name, from inside the VPC. There
is no public route, so this is a one-shot task on the cluster rather than a curl
from a laptop:

```bash
aws --profile oxy --region us-west-2 ecs run-task \
  --cluster oxy-cluster --task-definition oxy-alia-integrations \
  --network-configuration "$(aws --profile oxy --region us-west-2 ecs describe-services \
      --cluster oxy-cluster --services alia-integrations \
      --query 'services[0].networkConfiguration' --output json)" \
  --overrides '{"containerOverrides":[{"name":"alia-integrations","command":["curl","-sf","http://integrations.alia.internal.oxy.so:3005/health"]}]}'
```

Read its output from CloudWatch `/oxy/ecs`. Reuse the LIVE service's network
configuration as above rather than hardcoding subnets — the cluster's subnets are
public with no NAT gateway, so a task launched with `assignPublicIp=DISABLED`
can never pull its image.

**What `/health` does NOT tell you.** It reports `status: ok` without touching
Postgres. A task whose database is unmigrated answers 200 — the adapters' restore
queries throw into the per-adapter `try/catch` in `index.ts` and the process
stays up. So read the migration step's own output in the step 4 job log, and read
the task's CloudWatch stream for `Postgres pool ready` followed by adapter lines
without `Failed to initialize`.

### 6. Arm the API — last, alone, and reversible

Create the repo VARIABLE (not secret) `INTEGRATIONS_URL` in `OxyHQ/Alia`:

```
http://integrations.alia.internal.oxy.so:3005
```

Then re-run `deploy-aws.yml`. `TASK_ENV_OVERRIDES_JSON` puts it on the new
revision, `TASK_SECRET_OVERRIDES_JSON` keeps the secret bound, and hosted MCP
comes alive.

A variable rather than a workflow literal so that this step is a decision
somebody makes, not a side effect of a merge — the same discipline used when
adopting a complete Kaana task revision. Undo is deleting the variable and
re-running the deploy.

**The half-armed combination is refused rather than warned about.**
`deploy-aws.yml` fails if `INTEGRATIONS_URL` is set while the
`INTEGRATIONS_SECRET` secret is not: the API would hold an endpoint it cannot
authenticate to, `mcp.ts` needs both so nothing would visibly break, and it would
sit there looking configured. The condition only arises when somebody sets the
variable deliberately, and either fix is one action.

## What breaks if the order is wrong

| swap | what happens |
| --- | --- |
| **3 before 1** | Every task launch fails with `ResourceInitializationError: unable to pull secrets` — the definition names an SSM parameter that is not there. The apply is green |
| **4 before 3** | The image push fails with `AccessDenied` after a full ARM64 build: no ECR repository, and `alia-integrations` not yet in the deploy role's allow-list |
| **6 before 4** | The API holds a URL for a service with no running task. `/mcp/*` management routes 5xx. Chat degrades quietly rather than failing — `buildMcpTools` catches and returns an empty tool set — which is worse, because the surface that reports the problem is the one nobody is looking at |
| **6 before 2** | Refused by the deploy, by design (above) |
| **migration after the rollout** | The service boots, `/health` returns 200, and every adapter's restore query fails into a `try/catch`. This is why `deploy-ecs-image.sh` runs the migration as a one-shot on the NEW task definition BEFORE `update-service`, and fails the deploy with the task's CloudWatch logs if it exits non-zero |

## Verification, and the false pass to watch for

After the step 6 deploy:

```bash
aws --profile oxy --region us-west-2 ecs describe-task-definition \
  --task-definition "$(aws --profile oxy --region us-west-2 ecs describe-services \
      --cluster oxy-cluster --services alia \
      --query 'services[0].taskDefinition' --output text)" \
  --query 'taskDefinition.containerDefinitions[0].{env:environment[].name,secrets:secrets[].name}'
```

Names only. Assert `INTEGRATIONS_URL` is in `env` and `INTEGRATIONS_SECRET` is in
`secrets`, and that the revision you are reading is the one the SERVICE points
at — a `register-task-definition` that was never adopted leaves that unchanged,
which is the failure this whole runbook is about.

The false pass: a deploy that reports success while the service points at the
previous revision. Assert the revision identity, never just the job's exit code.

## Rollback

Delete the `INTEGRATIONS_URL` repo variable and re-run `deploy-aws.yml`. The API
returns to today's behaviour on the next revision — hosted MCP inert, everything
else untouched.

Repointing `alia` at an older revision also works and is faster, with one caveat
worth writing down because nothing will report it: both overrides are re-asserted
on every deploy, so a manual repoint is undone by the next merge unless the
variable is deleted too.

The integrations service itself needs no rollback step — nothing depends on it
while the API is unarmed. To stop it, set `desired_count` to 0 in
`app-alia-integrations.tf` and apply. Note that `desired_count` is deliberately
NOT in that service's `ignore_changes`, so a manual `update-service --desired-count`
is reverted by the next apply; changing the file is the durable way.
