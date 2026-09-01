# Runbook: rolling Alia back

A safe rollback restores product behaviour without restoring a direct upstream
provider path. Alia's hosted inference provider is Kaana; there is no emergency
provider bypass and no environment-key fallback.

## Choose a safe revision

Inspect the candidate task definition before repointing. It must:

- contain the complete Kaana/Oxy application configuration described in
  [kaana-cutover](./kaana-cutover.md);
- contain no upstream-provider credential variable or provider endpoint;
- use `KAANA_BASE_URL` and Kaana-signed headers only;
- depend on Oxy policy resolution for routing-profile `authorizedRoutes`.

If the candidate calls a provider directly, do not deploy it. Fix forward or
stop hosted inference visibly. Availability does not authorize restoring the
credential/routing boundary this migration removes.

## Repoint ECS

Resolve the current service and candidate revision read-only, then update the
service to that exact revision:

```bash
aws ecs update-service \
  --profile oxy \
  --region us-west-2 \
  --cluster oxy-cluster \
  --service alia \
  --task-definition oxy-alia:<revision>
```

Wait for stability and read back all of the following:

- `services[0].taskDefinition` equals the requested revision;
- `runningCount == desiredCount` and desired count is positive;
- the primary deployment is `COMPLETED`;
- `/health` comes from that image and reports the `kaana` field;
- one real inference request returns a Kaana receipt with expected Oxy
  attribution.

`COMPLETED` at zero tasks, a registered-but-unadopted revision, or a successful
health endpoint without an inference receipt are false passes.

## Database migrations

Do not reverse an applied destructive migration by deploying older code.
Migrations 0055 and 0056 rename the active routing-profile schema in `pre` and
remove the rolling compatibility surface in `post`. After 0056, an older image
that queries the removed names is not a valid rollback target.

If a post-phase migration failed, inspect the migration ledger before any new
deploy. A pending `post` can block later `pre` migrations; clear it with the
repo's migrator and the exact approved phase, not with ad-hoc SQL.

## Secrets and credentials

Rolling Alia back does not rotate Oxy application credentials or the Kaana edge
signing key. Rotate them separately if compromise is suspected. Upstream
provider credentials are owned by Kaana's database and credential roles; an
Alia rollback must neither read nor recreate them.
