# Runbook: delivering the Relay cutover variables to production

How each of the ten variables `relay-boot-check.ts` demands actually reaches the
**running** ECS task, and in what order to land them so that a mistake costs a
retry rather than an outage.

This is a DELIVERY runbook, not a decision. Whether to cut over is
[`docs/migration/epic-139-status.json`](../migration/epic-139-status.json)
`blockers.cutover`; that block also records the four things the cutover needs
which are not variables at all (an ApplicationCredential, `INFERENCE_EDGE_AUDIENCE`
on `oxy-api`, a priced catalogue route, and a billable provider account).

**Never print, echo, log or write the value of `ALIA_RELAY_CREDENTIAL_KEY` or
`ALIA_RELAY_CREDENTIAL_SECRET`** — not to a file, a PR body, a commit message, a
test fixture or a job log. Every command below is written to move them without
rendering them.

---

## The trap this runbook exists for

**Terraform cannot deliver any of these variables, and it fails silently.**

`oxy-infra/terraform-uswest2/modules/app-service/main.tf` carries
`ignore_changes = [task_definition, desired_count]`, and its own comment states
the consequence:

> An apply registers a new revision and nothing adopts it. `ignore_changes` stops
> the SERVICE from pointing at it, and CI does not inherit it either: the deploy
> script bases each new revision on `services[0].taskDefinition` — the revision
> currently RUNNING — so the chain descends from CI's last deploy and never reads
> Terraform's. An environment variable or secret added here therefore lands in a
> revision nothing runs and nothing inherits, indefinitely and with no error.

`oxy-infra/AGENTS.md` states the same rule in one line — *"'belongs here' is
OWNERSHIP, not delivery"* — and names the two mechanisms that do work. A cutover
plan that says "add them in Terraform and apply" **does nothing, reports nothing,
and looks done.**

Declaring them in `oxy-infra` is still correct and should still happen: a file
that omits a variable production needs misleads whoever reads it next to decide
what production has. It is simply not a rollout.

## Why an adopted revision persists, and an unadopted one is lost

`.github/scripts/deploy-ecs-image.sh` renders every new revision like this:

1. `current_task_definition="$(jq -r '.services[0].taskDefinition' …)"` — the
   revision the SERVICE POINTS AT (`:107`).
2. `aws ecs describe-task-definition --task-definition "$current_task_definition"`
   (`:419`), strip the read-only fields, swap `.image`, merge
   `TASK_SECRET_OVERRIDES_JSON` into `.secrets`, `register-task-definition`
   (`:481`).
3. `update-service` onto the new revision.

`.environment` is copied forward **verbatim**. `.secrets` is copied forward
except for names the overrides replace. So, plainly:

- **Register-only is lost.** `register-task-definition` does not repoint
  anything, so the next deploy reads a revision that is not yours and your
  variables never existed as far as the chain is concerned.
- **Register + repoint persists.** Once `update-service` points the service at
  your revision, it becomes `services[0].taskDefinition`, every later CI deploy
  descends from it, and the variables carry forward indefinitely with no further
  action.

**This is not a theory — it was executed on the neighbouring service the same
day.** `oxy-oxy-api:231` (registered by `oxy-github-deploy`, 2026-08-19T14:00:41)
carries no `RELAY_*` name at all. `oxy-oxy-api:232` (registered by
`user/oxy-admin`, 14:08:09, seven minutes later) adds exactly `RELAY_BASE_URL`
and `RELAY_EDGE_SIGNING_KEY_ID` to `environment[]` and
`RELAY_EDGE_SIGNING_PRIVATE_KEY` to `secrets[]`, and nothing else. Terraform PR
`#74` — *"declare oxy-api's route to the inference data plane"* — merged the same
day and delivered none of it. A human did, by hand, and the service points at 232.

## The one interaction that can lose the variables after they land

The `alia` service carries `deploymentCircuitBreaker { enable: true, rollback:
true }` (measured live). If the cutover revision's tasks fail to reach a steady
state, **ECS repoints the service back to the previous revision** — and the
previous revision is the one without the variables.

`relay-boot-check.ts` makes that outcome likely rather than exotic, because it is
fail-closed by design: `index.ts:376` calls `runBootGuards({ … exit: (code) =>
process.exit(code) })`, `lib/boot-guards.ts:116` calls
`relayBootConfigurationFailure(env)`, and any one of the ten variables missing or
malformed terminates the process. A half-delivered cutover does not degrade; it
crash-loops.

**Alia's own deploy fails loudly when that happens** — `deploy-ecs-image.sh:207`
selects the PRIMARY deployment *by task-definition identity* and requires
`rolloutState == COMPLETED` with `running == desired >= 1`, so Alia does not have
the silent-green-on-rollback gap `oxy-infra/AGENTS.md` describes for other repos.

**The silence is one deploy later.** The rollback fails the deploy that caused it,
but it has already moved the service pointer back. The NEXT unrelated merge
deploys from the pre-cutover revision, the variables are gone from the chain, and
nothing reports anything — the symptom is "the flag stopped working". If a
cutover revision is ever rolled back, treat the variables as lost and re-deliver
them before doing anything else.

---

## Delivery, per variable

Ten variables, three mechanisms. Two of them are Alia-repo changes that survive
by construction; the third is by hand and survives only once adopted.

| variable | kind | mechanism |
| --- | --- | --- |
| `ALIA_RELAY_CREDENTIAL_KEY` | secret | GitHub repo secret → SSM sync step → `TASK_SECRET_OVERRIDES_JSON` |
| `ALIA_RELAY_CREDENTIAL_SECRET` | secret | same |
| `ALIA_RELAY_ACCOUNT_ID` | plain | hand-registered revision + repoint |
| `ALIA_RELAY_APPLICATION_ID` | plain | same |
| `ALIA_RELAY_CREDENTIAL_ID` | plain | same |
| `ALIA_RELAY_ENVIRONMENT` | plain | same |
| `ALIA_RELAY_INFERENCE_SCOPES` | plain | same |
| `RELAY_BASE_URL` | plain | same |
| `OXY_API_URL` | plain | **already present** on `oxy-alia:105` |
| `ALIA_RELAY_CLIENT_ENABLED` | plain | same as the other plain ones — **and it goes LAST, alone** |

### A. The two secrets — the mechanism Mention already uses

`deploy-ecs-image.sh` supports `TASK_SECRET_OVERRIDES_JSON`: a JSON object
mapping an environment-variable name to a **complete SSM parameter ARN**, merged
into `.secrets` at register time (`:412-417`, `:466-478`), validated at `:77-92`
(≤ 20 entries, name `^[A-Z][A-Z0-9_]{0,127}$`, value a full SSM ARN).

**Alia does not set it today** — the script defaults it to `{}`. Mention does, and
is the pattern to copy verbatim: its deploy step carries a literal
`{"MENTION_MCP_JWT_SECRET":"arn:…:parameter/oxy/mention/…", "DATABASE_URL":"…"}`.
The behaviour is covered by `.github/scripts/test-deploy-ecs-image.sh:345`.

Three edits, all in this repository, and all three are required — any one alone
delivers nothing:

1. **Two GitHub repo secrets**, `ALIA_RELAY_CREDENTIAL_KEY` and
   `ALIA_RELAY_CREDENTIAL_SECRET`. Set them through the GitHub UI or
   `gh secret set <NAME>` reading from stdin, never as a command-line argument.
   **Never set either to a placeholder** — `-`, empty or `TODO`. The sync step
   skips empty and `-`, but a real-looking placeholder is written to SSM and the
   next task launch gets it.
2. **Two lines in the `Sync GitHub secrets -> SSM` step** of
   `.github/workflows/deploy-aws.yml` — an `APP_*` entry in that step's `env:`
   and a matching `sync_secret` call writing to `/oxy/alia/<NAME>`. The step's own
   comment is explicit: *"Adding a new one means adding it here, or it never
   reaches SSM."* The enumeration is deliberate and must not become a loop; a
   workflow that expands the whole `secrets` context makes every run wait for a
   human approval.
3. **`TASK_SECRET_OVERRIDES_JSON`** on the `Register immutable task definition and
   deploy` step, naming both parameters by full ARN
   (`arn:aws:ssm:us-west-2:237343248947:parameter/oxy/alia/<NAME>`).

**No IAM change is needed.** The task execution role `oxy-ecs-execution` carries
an inline policy granting `ssm:GetParameter`/`GetParameters` on
`arn:aws:ssm:us-west-2:237343248947:parameter/oxy/*` — a prefix wildcard, so new
parameters under `/oxy/alia/` are covered — plus `kms:Decrypt` conditioned on
`kms:ViaService = ssm.us-west-2.amazonaws.com`, which is what lets it read
`SecureString` parameters encrypted under `alias/aws/ssm`.

This mechanism is durable: it is re-asserted on **every** deploy, so it survives a
rollback without intervention.

### B. The seven plain variables — hand-registered revision, then repoint

There is no environment-variable equivalent of `TASK_SECRET_OVERRIDES_JSON`.
`deploy-ecs-image.sh` touches `.environment` for exactly one name,
`INTERNAL_METRICS_ENABLED` (`:459-464`); everything else is carried forward from
the running revision and cannot be introduced by CI. So these arrive the way
`oxy-api`'s `RELAY_BASE_URL` did:

1. `describe-task-definition` on the revision the service currently points at.
2. Strip `taskDefinitionArn`, `revision`, `status`, `requiresAttributes`,
   `compatibilities`, `registeredAt`, `registeredBy`.
3. Append the entries to `containerDefinitions[0].environment`. **Keep the image
   digest exactly as it is** — this is a configuration change, not a release.
4. `register-task-definition --cli-input-json file://…`.
5. `update-service --cluster oxy-cluster --service alia --task-definition
   oxy-alia:<new>`.
6. Watch the rollout to `COMPLETED` with `running == desired`, then read the
   variables back off `services[0].taskDefinition`.

**Step 5 is the whole runbook.** Stopping after step 4 produces a revision nothing
runs and nothing inherits — the same dead end as the Terraform path.

**The durable alternative, if this is done more than once:** add a
`TASK_ENV_OVERRIDES_JSON` hook to `deploy-ecs-image.sh`, mirroring the secrets one
(`oxy-infra/AGENTS.md` names this as the fix and notes `TASK_SECRET_OVERRIDES_JSON`
is secrets-only). It is an Alia-repo change — each repo owns its copy of the
script — and `test-deploy-ecs-image.sh` already has the shape to test it. That
converts every plain variable from "survives if nobody rolls back" to "re-asserted
every deploy".

### C. Also declare them in `oxy-infra`, and say what it is

Add the same names to `terraform-uswest2/app-services-realtime.tf`'s `alia`
module, with a comment saying **DECLARATION, NOT A ROLLOUT** — the shape open PR
`#60` already uses for `API_BASE_URL`/`ALIA_API_URL`. This keeps the file honest
about what production runs. It delivers nothing on its own.

---

## Order of operations

`relay-boot-check.ts:101` is `if (!isRelayClientEnabled(env)) return null;`, and
`direct-provider-guard.ts:111` is the same line. So **with
`ALIA_RELAY_CLIENT_ENABLED` unset, none of the other nine variables is read,
parsed or validated by anything.** They are completely inert.

That is what makes this safe, and it decides the order:

1. **Land the two secrets** (mechanism A). Merge, let CI deploy, confirm both
   names appear in the running revision's `secrets[]`. Inert.
2. **Land the six remaining plain variables** — everything except
   `ALIA_RELAY_CLIENT_ENABLED` — by hand (mechanism B), in one revision, and
   repoint. Inert.
3. **Verify the preconditions that are not variables**, because step 4 is the
   first moment anything fails: the ApplicationCredential exists and carries
   `inference:invoke`; `INFERENCE_EDGE_AUDIENCE` is set on `oxy-api` to an
   audience that admits Alia's application; a priced catalogue route resolves for
   whichever model reference Alia will name.
4. **Flip `ALIA_RELAY_CLIENT_ENABLED=true` in its own revision, alone**, and
   repoint. This is the only step that can refuse to boot, and having it alone in
   a revision means the rollback target is a revision that already carries the
   other nine — so a failed arm costs one repoint, not a re-delivery.

**Never bundle step 4 with steps 1-2.** A single revision carrying all ten either
works or crash-loops back to a revision with none of them.

### Before step 4, check the other guard too

Arming the flag also arms `directProviderModeFailure`, which refuses to boot when
`GATEWAY_API_URL` or any name in `PROVIDER_CREDENTIAL_ENV` is set. `oxy-alia:105`
sets neither, so this is expected to pass — but confirm it against the revision
you are about to arm rather than against this sentence. Note it inspects the
process ENVIRONMENT only: rows in `provider_keys` are invisible to it, and
emptying that table is a separate piece of work (epic #139 L521).

## Verification, and what would show a false pass

After each repoint:

- `aws ecs describe-services --cluster oxy-cluster --services alia --query
  'services[0].taskDefinition'` — assert it is YOUR revision. A `register` that
  was never adopted leaves this unchanged, which is the failure mode this whole
  runbook is about.
- `describe-task-definition` on that revision and assert the variable **names**
  are present in `environment[]` / `secrets[]`. Names only.
- `services[0].runningCount == desiredCount` and the PRIMARY deployment's
  `rolloutState == COMPLETED`. **`rolloutState COMPLETED` alone is vacuous** on a
  service parked at zero; check the counts separately.
- `GET https://api.alia.onl/health` — `"relay"` moves from `"disabled"` to
  `"unknown"` the moment the flag is on, because `relay-connectivity.ts` reports
  `disabled` only while the flag is off. **`"unknown"` is the correct post-arm
  reading**, not a fault: a task that has never called Relay has no evidence about
  it. `"reachable"` requires a completed call.

The false pass to watch for: a deploy that reports success while the service
points at the previous revision. Assert the revision identity, never just the
deploy's exit code.

## Rollback

Repoint the service at the last revision that worked:
`update-service --task-definition oxy-alia:<previous>`. Nothing else is needed —
the flag, the principal and the endpoint all live in the task definition, so the
previous revision is a complete pre-cutover state.

If the rollback target is a revision from BEFORE the plain variables landed, the
nine variables are gone from the chain and step 2 must be repeated before step 4
is retried. That is the case worth writing down, because nothing will report it.
