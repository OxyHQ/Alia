# Alia integrations rollout

The private ECS service has its own PostgreSQL database. The API uses
`http://integrations.alia.internal.oxy.so:3005`, declared by Terraform's
`integrations` service in `alia.internal.oxy.so`.

## Prerequisites

Deploy the Oxy issuer and shared core reader before these consumers. Bind both
`oxy-alia-task` and `oxy-alia-integrations-task` to Alia's registered application,
with explicit deployment environments. Each receiver pins its exact opposite
process and the canonical audience exported by `@alia.onl/server`. Temporary
workload credentials replace internal scopes and shared gateway/bot passwords.
External connector OAuth and provider webhook signatures remain.

Deploy the channel task schema before the API runtime. New links create a
revocable automation task with the real requester and store only its ID. Run the
controlled legacy task migration where a valid existing requester proof exists.
Unprovable connections renew automatically on the owner’s normal signed-in visit;
never manufacture requester authority from an account ID.

## Configuration

Deploys overlay `INTEGRATIONS_URL` and explicitly remove inherited process secrets.
Phase C no longer has a dependency between the two deployment workflows: both
sides already emit workloads. Before releasing C, verify the phase-B API and
gateway runtime digests, completed task reconciliation and old-task drain. Do not
use C to skip that transition. Terraform alone does not update the running
revision; read back deployed task definitions.

`/oxy/alia-integrations/DATABASE_URL` remains an SSM-owned database credential.
`TOKEN_ENCRYPTION_KEY` remains storage encryption for connector records; rotation
requires a data migration. These are not service authentication. Workflows read
parameter metadata without printing or decrypting values. Retire obsolete SSM
parameters through infra only after both transports are verified live.

## Verification

1. Confirm issuer readiness and both active environment-bound registrations.
2. Confirm both ECS rollouts completed with the intended image digest.
3. Resolve the private Cloud Map address from an API task.
4. Read running task definitions: no Oxy client keys; process secrets remain
   only during B and must disappear in C.
5. Exercise an owned connector and linked channel task; reject an external app,
   another workload, missing context and another account's session.
6. Revoke/disconnect the task; the next private tool call must fail.

A health check alone does not prove authentication or account isolation. Roll
back only to an image whose protocol matches its runtime configuration. Never
restore account-header impersonation or remove storage keys to recover.
