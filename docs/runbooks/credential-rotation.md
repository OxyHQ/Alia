# Runbook: rotating and revoking Alia credentials

This runbook covers credentials Alia legitimately owns. Upstream inference
provider keys are owned by Kaana, stored encrypted in PostgreSQL and rotated
through Kaana's credential administration. Never put one in Alia's environment,
SSM tree, GitHub secrets or database.

If an upstream credential is exposed, revoke it at the provider first and use
Kaana's incident runbook. Removing it from Alia is cleanup, not revocation.

## Inventory

| Credential | Owner and storage | Rotation effect |
| --- | --- | --- |
| Alia workload identity | Temporary AWS task/SSO role credentials; live Oxy workload binding | Rotate or revoke the role/binding; no application key pair |
| OAuth and connector tokens | encrypted PostgreSQL columns | API and integrations must share `TOKEN_ENCRYPTION_KEY` |
| Bot/platform tokens | PostgreSQL; encrypted where declared | Restart or reconnect the affected integration |
| Product webhook secrets | PostgreSQL | Producer and verifier must overlap or switch atomically |

## Alia workload identity

The API and integrations authenticate with their registered workload, using
short-lived AWS role credentials and the shared Oxy SDK. Local development uses
an IAM/SSO development role through the same server-only provider. A customer
API key is never a replacement for an own workload, and own workloads do not
request scopes. External customer keys and OAuth connections remain scoped.

To rotate a process role, register the replacement's exact provider/subject,
application, owner and environment in Oxy, deploy that role to the intended
process, and verify the running task definition, digest and successful
workload exchange. Gateway receivers pin the expected calling workload; update
those server-controlled pins as part of the same rollout. Then revoke the old
binding and remove its role access. On an exposure, revoke the affected role or
binding first. Never print credentials, signed attestations or tokens.

Revocation is checked against the live Oxy binding even while an issued token
has not expired. A readiness probe checks configuration, not successful
identity exchange: verify a real authorized request and its account attribution.
Do not restore a revoked binding by rolling back an image. Alia has no Kaana
signing key; Oxy owns and rotates the Oxy-to-Kaana signing boundary.

`SERVICE_SECRET`, `INTEGRATIONS_SECRET` and `OXY_SERVICE_API_*` are retired for
own process authentication. Deployment removes those inherited bindings
explicitly. After every running task has migrated, remove unused SSM parameters
through the infrastructure rollout. `TOKEN_ENCRYPTION_KEY` remains required for
stored connector data and is handled separately below.

Oxy application events have no Alia-held per-app webhook secret. Migration
`0056` retired the former `oxy_services.webhook_secret` values. Revoke the
publisher's live workload binding in Oxy; do not add a replacement shared
secret. User-owned `triggers.webhook_secret` values remain part of the trigger
API and must rotate with their producer and verifier.

## `TOKEN_ENCRYPTION_KEY`

The API and integrations service use the same AES-256-GCM key and wire format.
Rotating only one process makes existing encrypted OAuth, connector, bot and
show-ingest values unreadable. Both bind the one SSM parameter
`/oxy/alia/TOKEN_ENCRYPTION_KEY`, which is the only copy (no GitHub secret). Drain
work, re-encrypt existing rows through an explicit migration, write the new key
with `aws ssm put-parameter --overwrite`, then roll both services.

## Verification

Record only identifiers, timestamps and affected row/task counts. Verify the
running revision, not merely an SSM write or registered task definition. A
health probe is insufficient for inference credentials: use one real request
and verify its Oxy attribution and Kaana usage.
