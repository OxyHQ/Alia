# Runbook: rolling back a release

What an operator runs to undo a deploy, how to tell whether there is anything to
undo, and what observation justifies undoing it rather than fixing forward.

Read [deployment](../deployment.md) first for how a release is built. This
document covers only the reverse direction, and it is written against what
`.github/workflows/deploy-aws.yml` and `.github/scripts/deploy-ecs-image.sh`
actually do — including two behaviours that are counter-intuitive enough to
mislead someone working from the idealised procedure.

## What rollback means here

Per #139 workstream 18, rollback **returns traffic to the last known good Relay
version — never to direct providers inside Alia.** Falling back to in-process
provider calls would undo the cutover, re-expose upstream credentials to the
Alia runtime, and put spend back on Alia's own provider accounts, which is a
larger and less reversible change than whatever prompted the rollback.

**Today that path does not exist yet, and the honest version matters more than
the aspirational one.** The Relay client in `packages/api/src/lib/inference/` is
written and unwired: nothing in `packages/api` imports it, frozen by
`packages/api/src/lib/inference/__tests__/relay-boundary.test.ts:197`–`:207`, and
`packages/api/src/lib/inference/product-seam.ts:38`–`:41` records that a
half-wired seam is worse than an unwired one because it makes the cutover look
done. The Relay variables are deliberately absent from `deploy-aws.yml`'s secret
list, and [deployment](../deployment.md) records them as unset in every
environment — a claim about configuration this repository can see, so confirm
`ALIA_RELAY_CLIENT_ENABLED` in the live task definition before relying on it.

So a rollback performed **before** the workstream 8 cutover is an ordinary image
rollback: both revisions call providers in-process, and there is no Relay version
to return to. A rollback performed **after** it must additionally confirm that
the revision being rolled back to is one that speaks to Relay — which, once
several such revisions exist, means checking the image, not the date.

## Before anything: is this service even serving?

**This repository records the `alia` ECS service as parked at `desiredCount: 0`
for the Postgres cutover** (`deploy-ecs-image.sh:122`–`:125`). That is a claim in
a code comment, not a live measurement — nothing in this repository can observe
the cluster. Everything below reads differently depending on which state you are
in, so establish it first rather than assuming either way.

```bash
aws ecs describe-services --cluster oxy-cluster --services alia \
  --profile oxy --region us-west-2 \
  --query 'services[0].{status:status,desired:desiredCount,running:runningCount,taskDefinition:taskDefinition}'
```

If `desired` and `running` are `0`, **nothing is serving and there is nothing to
roll back.** A bad image cannot be hurting users, because no user is reaching it.
The correct response to a bad release in that state is to fix forward, not to
roll back — see [Rolling back at zero capacity](#rolling-back-at-zero-capacity)
for the one case where a rollback is still warranted.

This requires AWS access under the `oxy` profile in `us-west-2`. This repository
does not provide it and its CI never holds it; the cluster, the service and the
task definition belong to `oxy-infra`.

## A green "Deploy to AWS" run does not mean a release happened

This is the failure this section exists to prevent. At `desiredCount: 0` the
workflow does everything that is real — it runs the migration, registers a task
definition revision, and **repoints the service at it** — then skips the one step
that would be a lie, the rollout, and **exits 0**
(`deploy-ecs-image.sh:588`–`:624`). The run is green. The commit is deployed in
the sense that ECS would launch it. Nobody is running it.

It says so, loudly, in the job log:

```
NO ROLLOUT PERFORMED: ECS service alia is at desiredCount=0 and is running ZERO tasks.
NO ROLLOUT PERFORMED: the task definition WAS registered and the service now points at it: <arn>
NO ROLLOUT PERFORMED: image <uri> is NOT live and alia is serving NOTHING. This deploy released nothing to users.
```

### Telling "schema advanced" from "code is serving"

These are separate facts and a green run answers neither by itself.

**Did the schema advance?** The same block states which phases ran
(`deploy-ecs-image.sh:618`–`:622`), in one of two forms:

```
NO ROLLOUT PERFORMED: MIGRATIONS DID RUN — phase=pre before the repoint and the post-deploy one-shot after it. The schema is fully migrated; only the rollout was skipped.
NO ROLLOUT PERFORMED: MIGRATIONS DID RUN — phase=pre before the repoint. This release carries no post-deploy one-shot.
```

The migration runs as its own `ecs run-task`, not through the service
(`deploy-ecs-image.sh:494`–`:500`), which is why zero capacity does not stop it.
`RUN_MIGRATIONS: 'true'` is set unconditionally by the workflow
(`deploy-aws.yml:208`), and the phase is `pre` — the script's default, never
overridden (`deploy-ecs-image.sh:26`). A `post` phase runs only when this release
carries one, detected by grepping the journal for a phase marker
(`deploy-aws.yml:169`–`:178`). **Read these lines rather than inferring from the
green tick**: a migration failure fails the job before the repoint, so green does
mean the migration succeeded — but green says nothing about whether this release
had a `post` phase to apply.

**Is code serving?** Only `runningCount` answers it. Ask ECS, per the command
above, and confirm with the application itself:

```bash
curl -fsS https://api.alia.onl/health/ready
```

Use `/health/ready`, not `/health/live`. `/health/live` consults nothing
(`packages/api/src/routes/health.ts:132`) and answers `alive` from any process
that has started. `/health/ready` runs a real query against PostgreSQL and checks
provider health (`:138`–`:154`).

Read the failure carefully: at zero capacity the 503 comes from the load balancer
with no healthy target, and a task that is running but unready also answers 503.
The two look alike from `curl` and mean opposite things, so let `runningCount`
settle the question and use the curl only to confirm. A successful response is
also not proof it came from the revision you just deployed — the image digest on
the running task is what proves that.

Note the gap this leaves: the `oxy-alia` target group health-checks
`/health/live` (`packages/api/src/routes/health.ts:28`), so a task whose database
is unreachable is still marked healthy and still receives traffic. **The load
balancer will not take a broken task out for you.** Moving the target group to
`/health/ready` is an `oxy-infra` change.

## The rollback commands

### The normal case: capacity above zero

The deploy script rolls back automatically on a failed rollout
(`deploy-ecs-image.sh:629`–`:634`) and on a failed post-deploy reconciliation
(`:659`–`:669`), returning the service to the revision it was running when the
deploy started (`rollback_service`, `:366`–`:383`). If that already happened, the
job log says `Rolling alia back to <arn>` and there is nothing left to run.

To roll back by hand, point the service at the previous revision and let it
deploy:

```bash
# 1. What is it on now, and what came before?
aws ecs describe-services --cluster oxy-cluster --services alia \
  --profile oxy --region us-west-2 \
  --query 'services[0].taskDefinition'

aws ecs list-task-definitions --family-prefix alia --sort DESC --max-items 10 \
  --profile oxy --region us-west-2

# 2. Repoint and roll.
aws ecs update-service --cluster oxy-cluster --service alia \
  --task-definition <previous-revision-arn> \
  --desired-count <current-desired-count> \
  --deployment-configuration '{"deploymentCircuitBreaker":{"enable":true,"rollback":true},"minimumHealthyPercent":100,"maximumPercent":200}' \
  --profile oxy --region us-west-2

# 3. Watch it reach a steady state.
aws ecs describe-services --cluster oxy-cluster --services alia \
  --profile oxy --region us-west-2 \
  --query 'services[0].deployments[?status==`PRIMARY`].[rolloutState,runningCount,desiredCount]'
```

The deployment configuration is copied from `rollback_service`
(`deploy-ecs-image.sh:373`–`:377`) deliberately: the circuit breaker is what stops
a rollback that is itself broken from draining the service.

**Do not pick the revision by number alone.** Confirm its image is the one you
mean:

```bash
aws ecs describe-task-definition --task-definition <arn> \
  --profile oxy --region us-west-2 \
  --query 'taskDefinition.containerDefinitions[?name==`alia`].image'
```

The workflow pins an immutable digest (`deploy-aws.yml:207`, enforced at
`deploy-ecs-image.sh:9`–`:12`), so that image string resolves to exactly one
build. It is the only reliable link from a running task back to a commit.

### Two things that do not do what they look like

**`register-task-definition` does not repoint a service.** It creates a revision
and nothing more. ECS launches whatever revision the SERVICE is configured with,
so registering a "rollback revision" and stopping there changes nothing — and the
deploy script derives its next render from `services[0].taskDefinition`
(`deploy-ecs-image.sh:107`, comment at `:131`–`:137`), so every subsequent deploy
would keep building on the revision you thought you had replaced.

**A `desired_count` bump launches the revision the service is configured with,
not the newest.** Scaling up is not a way to deploy. If the service is parked at
zero and pointed at a revision you do not want live, raising capacity starts
exactly that revision.

The correction for both is the same, and it is what the deploy script already
does at zero capacity (`deploy-ecs-image.sh:538`–`:547`): **repoint explicitly,
at whatever capacity the service currently has.**

### After the Relay cutover: check the target before you repoint

The section at the top of this runbook states the rule. This is how you satisfy
it, and it is a check you run **before** `update-service`, not after — repointing
at a revision that speaks to providers directly is the change you are trying not
to make, and ECS will carry it out perfectly.

**A revision speaks to Relay when its container environment sets
`ALIA_RELAY_CLIENT_ENABLED` to exactly `true`.** Not `1`, not `TRUE`:
`isRelayClientEnabled` (`packages/api/src/lib/inference/relay-client.ts:103`–`:104`)
compares against the literal string, and `relay-boot-check.ts` refuses to boot
when the flag is on and the principal is unusable. So the flag is a reliable
discriminator in both directions: a revision carrying it either speaks to Relay or
does not start.

```bash
# The rollback target's inference configuration, in one read. `environment` and
# `secrets` are separate arrays and a variable can be in either, so both are
# printed — a value absent from the first is not absent from the task.
aws ecs describe-task-definition --task-definition <candidate-revision-arn> \
  --profile oxy --region us-west-2 \
  --query 'taskDefinition.containerDefinitions[?name==`alia`].[
      environment[?starts_with(name, `ALIA_RELAY_`)],
      secrets[?starts_with(name, `ALIA_RELAY_`)],
      environment[?name==`GATEWAY_API_URL`]
    ]'
```

Read it against these three rules:

1. **`ALIA_RELAY_CLIENT_ENABLED` must be present and exactly `true`.** Absent or
   any other value means that revision calls providers in-process. **Do not roll
   back to it.** Roll back to an older revision that does carry the flag, or fix
   forward.
2. **All five principal variables must be present** —
   `ALIA_RELAY_ACCOUNT_ID`, `ALIA_RELAY_APPLICATION_ID`, `ALIA_RELAY_CREDENTIAL_ID`,
   `ALIA_RELAY_ENVIRONMENT`, `ALIA_RELAY_INFERENCE_SCOPES`
   (`packages/api/src/lib/inference/relay-boot-check.ts:70`–`:76`). A revision with
   the flag and a missing variable does not start; the task will crash-loop, and
   the rollback will look like a broken image rather than a missing value.
   `ALIA_RELAY_ENVIRONMENT` must also match the deployment: a `staging` principal
   on a production task is refused by construction.
3. **No direct provider route may be configured beside the flag.** Since #164 this
   is enforced rather than advised: `directProviderModeFailure`
   (`packages/api/src/lib/inference/direct-provider-guard.ts:102`) refuses to boot
   when the flag is on and either `GATEWAY_API_URL` or any provider credential is
   set, and `provider-egress-policy.ts` refuses outbound requests to provider hosts
   inside the process. So a revision cannot half-roll-back: it either speaks to
   Relay or it does not start. Read this column anyway — it turns a crash-loop you
   would otherwise diagnose as a bad image into a value you can see before you
   repoint.

**A rollback target that crash-loops is usually rule 2 or rule 3, not the image.**
Both guards exit the process at boot with the reason in the log, so read the task's
stopped-reason and the first lines of its log before concluding the build is bad.

**What the ALB polls is unchanged.** `/health/live` does not consult Relay;
`relay-connectivity.ts` reports into `/health` and `/health/ready` only, and reports
`disabled` while the flag is off. A rollback across the cutover boundary therefore
does not change what the target group considers healthy.

**Turning the flag off is not a rollback.** It is a cutover in reverse: it returns
inference to Alia's in-process provider stack, puts spend back on Alia's own
provider accounts, and re-exposes the `provider_keys` plaintext to the request
path. If the Relay version itself is the problem, the rollback target is the
**previous Relay version**, which is a different image with the flag still on. If
no such image exists yet, say so and escalate on #139 rather than clearing the
flag — that decision is larger than the incident.

The one exception, stated so nobody has to infer it: **before** the workstream 8
cutover no revision carries the flag at all, every revision calls providers
in-process, and this section does not apply. Use the ordinary image rollback
above.

### Rolling back at zero capacity

```bash
aws ecs update-service --cluster oxy-cluster --service alia \
  --task-definition <previous-revision-arn> \
  --desired-count 0 \
  --profile oxy --region us-west-2
```

`--desired-count 0` is not a typo and not a scale-down: it holds the service at
its current capacity while changing which revision a future scale-up would
launch. Omitting `--desired-count` here is the mistake — and note that the
automatic rollback paths deliberately do NOT run at zero capacity
(`deploy-ecs-image.sh:554`–`:557`, `:604`–`:608`), because `wait_for_service_rollout`
would block until `MAX_WAIT_SECS` waiting for a steady state that cannot arrive
with no tasks. At zero capacity, rollback is always manual.

**When is this worth doing at all?** Only when the registered revision would
break the next scale-up, or when the release advanced the schema in a way the
previous image cannot serve. Nothing is reaching users either way, so the urgency
is zero and fixing forward is almost always better.

### What you cannot roll back

**Migrations.** There is no down-migration path: `packages/api/src/db/migrate.ts`
applies forward phases and the ledger is a high-water mark. Rolling the image
back leaves the schema where the release put it. This is usually fine — `pre`
migrations are additive by definition — and is exactly why the phase split
exists.

It is NOT fine for a `post` migration, which is defined as one that breaks a
write the previous image performs (`deploy-ecs-image.sh:573`–`:577`). **If the
failed release carried a `post` phase that ran, rolling the image back gives you
the old code against a schema it was not written for.** Check the job log for the
post-deploy reconciliation before rolling back; if it ran, treat fixing forward as
the default and involve whoever owns the migration.

The journal today is 21 `pre` files and one `post` (`0016`), verified by grepping
`packages/api/drizzle` for the phase markers.

**A partly-applied phase sequence blocks the next deploy.** If a `post` migration
failed at zero capacity, the service is left pointed at the new revision with the
post phase unapplied, and the script says so explicitly
(`deploy-ecs-image.sh:607`). The next release's `pre` run is refused behind the
hole and that deploy fails at its migration step — this was measured in `alia`,
four consecutive merges deploying red behind an unapplied `0016` while every one
of their PRs was green (`deploy-ecs-image.sh:579`–`:587`). Clearing it needs a
`--phase=all` one-shot run by hand. Rolling back does not clear it.

### Redeploying a known-good commit instead

Sometimes the cleanest rollback is a forward deploy of the previous commit. Note
that `push` to `main` ignores `**.md` and `docs/**` (`deploy-aws.yml:8`–`:10`), so
a documentation commit will not trigger a deploy; and `workflow_dispatch` only
runs against `main` (`:36`). The `concurrency` group serializes rollouts and never
cancels in progress (`:17`–`:23`), so a dispatched run will queue behind an
in-flight deploy rather than racing it — wait for it rather than assuming it was
dropped.

## What survives a rollback, and what you must check

The epic requires that rollback preserve financial-event idempotency and
credential revocation. Both are preserved by the same property: **they are
enforced in the database, not in the image.**

**Financial idempotency.** `transactions.dedup_key` is a stored generated column
derived from `metadata ->> 'dedup'` with a unique index over it
(`packages/api/src/db/schema/billing.ts:384`, `:390`), and
`transactions.stripe_payment_intent_id` is unique too (`:389`). The renewal path
writes the transaction FIRST as a lock and treats the duplicate-key error as
"already credited, skip" (`:326`–`:334`). An older image performing the same
write hits the same constraint, so a webhook redelivery during or after a
rollback cannot double-credit.

The thing that WOULD break this is rolling the schema back, not the image. Do not
drop `transactions_dedup_key_key` to unblock anything.

**Credential revocation.** A revoked developer key is `is_active = false` in
`developer_api_keys`, checked on every request with no cache
(`packages/api/src/middleware/auth.ts:150`); a revoked provider key is
`is_active`/`is_archived` in `provider_keys`, filtered in the query that loads
them (`packages/api/src/db/providers/providerKeyRepository.ts:135`–`:150`). No
image carries a copy, so rolling back cannot resurrect a revoked credential.

**One real exception, and it is time-bounded.** Provider keys are cached
in-process for ten seconds (`packages/api/src/internal/providers/lib/key-manager.ts:35`–`:37`).
A task started by a rollback loads keys fresh, so this shortens rather than
extends the window. Nothing to do; stated so nobody goes looking for a cache to
clear.

**Check after any rollback that crosses a credential rotation.** If a credential
was rotated between the two revisions and the rotation was an environment change
rather than a database change, the older task definition may carry the OLD secret
ARNs — a deploy render carries forward every secret it is not told to replace.
Resolve every secret ARN the revision you are rolling back to names, not just the
one you were thinking about. See [credential-rotation](./credential-rotation.md).

## Decision thresholds

### What can be observed today

Be direct about this, because it is the constraint on every threshold below:
**there is no metrics pipeline.** `packages/api/src/lib/observability/metrics.ts:11`
claims to expose a `/metrics` endpoint compatible with Prometheus scraping, and
no route mounts it — `exportMetrics()` has no caller outside its own barrel
re-export, and the recorder functions beside it (`providerRequestRecorded`,
`agentTokensUsed` and the rest) have no callers either. `observability/alerts.ts`
is unwired the same way: `onAlert`, `getRecentAlerts` and `checkProviderCascade`
have no callers outside the observability directory.

What DOES work is structured logging. `recordEvent` is called from seven modules
including the chat completion path, and `LogObserver`
(`packages/api/src/lib/observability/log-observer.ts:15`–`:38`) writes
`agent.start`, `agent.end`, `tool.call` and `error` as pino records under the
`observability` subsystem. On ECS that is CloudWatch. Every threshold below is
therefore expressed as something an operator reads out of CloudWatch Logs
Insights or sees directly, and the numbers are left to be set rather than
invented.

### Roll back

Any one of these justifies a rollback without further discussion:

- **`/health/ready` fails across all tasks** and the cause is the new image
  rather than the database. A rollout that never reached a steady state has
  already been rolled back automatically; this is the case where it reached one
  and then degraded.
- **A rise in `agent.end (failed)` records** that begins at the rollout and does
  not recover within one deployment cycle. The rate that should trigger this is
  not stated here because no baseline exists to state it against — see the open
  question below.
- **Errors carrying provider or upstream detail into user-facing responses.** A
  model-abstraction leak is a rollback, not a fix-forward, because every minute
  of exposure is unrecoverable. The rule and its chokepoint are in
  [model abstraction](../model-abstraction.mdx).
- **Any incorrect financial write** — a double credit, a wrong charge, a credit
  grant to the wrong account. Stop the write path first, then decide.
- **A credential appearing in a log line or an error body.** Rolling back does
  not un-disclose it; roll back to stop the flow, then follow
  [provider-credential-exposure](./provider-credential-exposure.md), which is the
  document that actually resolves it.

### Fix forward

- **The service is at `desiredCount: 0`.** Nothing is reaching users. Rolling
  back buys nothing and adds a revision to reason about.
- **The release carried a `post` migration that ran.** The old image is not
  written against the current schema. See above.
- **A single route or feature is broken** while the rest serves correctly, and it
  is not one of the rollback triggers above.
- **The failure is in a dependency**, not the image. The deploy script has a
  protocol for exactly this — a smoke script may exit 75 to say "this failed and a
  rollback cannot repair it" (`deploy-ecs-image.sh:33`–`:41`), and the release
  stands while the job goes red. No smoke script is configured for `alia` today,
  so this judgement is currently a human one.

### Who decides

- **The deploy script decides automatically** for a failed rollout or a failed
  reconciliation, at capacity above zero. No human is in that loop, by design.
- **The on-call operator decides** for the health, error-rate and dependency
  cases, and does not need approval to roll back — a rollback to the immediately
  previous revision is the reversible action, and hesitating is the expensive one.
- **The #139 epic owner decides** anything that would return inference to direct
  providers, anything requiring a `--phase=all` migration run, and any rollback
  crossing the Relay cutover. These are not on-call decisions.

## Open questions

- **What is the error-rate threshold?** No baseline exists because no metric is
  exported. What would have to exist: `exportMetrics()` mounted on an
  authenticated route and scraped, or a CloudWatch metric filter over the
  `agent.end (failed)` log records with a published normal range. Until then
  "a rise that begins at the rollout" is the only statable form.
  *Owner: the #139 epic owner, with `oxy-infra` for the alarm.*
- **Is the metrics module dead or unfinished?** `metrics.ts` and `alerts.ts` are
  complete implementations with no callers, and `metrics.ts:11` documents an
  endpoint that does not exist. Either wire them or delete them; a module that
  looks like observability and reports nothing is worse than an absent one,
  because it answers "do we have metrics?" with a yes.
  *Owner: the #139 epic owner.*
- **When does the service leave `desiredCount: 0`?** Raising it is an `oxy-infra`
  terraform change (`deploy-ecs-image.sh:623`). Until then every deploy is green
  and released to nobody, and this runbook's normal path is untested in
  production. *Owner: the #139 epic owner, with `oxy-infra`.*
- **`DEPLOY_HEAD_GUARD_SCRIPT` points at a file that does not exist.**
  `deploy-ecs-image.sh:43` defaults it to `.github/scripts/require-current-main.sh`,
  which is absent from this repository. It is inert because the workflow never
  sets `DEPLOY_SHA`, and the script refuses cleanly if it ever does
  (`:61`–`:64`) — so this is a trap for whoever enables the guard, not a live
  fault. *Owner: the #139 epic owner.*
- **What is the rollback procedure once Relay is the inference path?** The
  "return traffic to the last known Relay version" half of workstream 18 cannot be
  written against code that does not exist yet. Revisit at the workstream 8
  cutover. *Owner: the #139 epic owner.*
