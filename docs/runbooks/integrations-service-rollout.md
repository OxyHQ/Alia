# Runbook: Alia integrations service rollout

`alia-integrations` is a private ECS service with its own PostgreSQL database.
The Alia API reaches it only inside the VPC at the exact Cloud Map address:

```text
http://integrations.alia.internal.oxy.so:3005
```

That name comes from Terraform's service `integrations` in namespace
`alia.internal.oxy.so`; do not invent a public or compatibility hostname.

## SSM ownership

These parameters are provisioned outside GitHub Actions and SSM is their source
of truth:

- `/oxy/alia-integrations/DATABASE_URL`
- `/oxy/alia/INTEGRATIONS_SECRET`

The shared gateway secret has one parameter. Both the API and integrations task
definitions bind it, so rotation cannot leave two copies disagreeing.

Neither deploy workflow accepts a GitHub `INTEGRATIONS_SECRET`, retrieves the
parameter value, uses decryption, prints it or overwrites it. Before registering
a task definition, workflows use `ssm describe-parameters` to verify only the
exact name and `SecureString` type. A missing or wrong-type parameter fails
closed.

`TOKEN_ENCRYPTION_KEY` remains a separately managed shared secret because both
services must decrypt the same connector records. Rotating it requires a data
migration; never overwrite one task independently.

## Durable API wiring

Every API deploy overlays both values onto the immutable task revision:

```text
INTEGRATIONS_URL=http://integrations.alia.internal.oxy.so:3005
INTEGRATIONS_SECRET=arn:aws:ssm:us-west-2:237343248947:parameter/oxy/alia/INTEGRATIONS_SECRET
```

The second line is an ECS secret binding ARN, not the secret value. Terraform
declares the same wiring, but the deploy workflow re-asserts it because the
existing ECS service deliberately ignores Terraform task-definition changes.

## Verification before traffic

1. Confirm both SSM parameter names and types with metadata-only calls.
2. Confirm the integrations service has positive desired/running counts, zero
   pending tasks and a completed rollout.
3. Resolve `integrations.alia.internal.oxy.so` from an API task in the VPC.
4. Read back both running task definitions and compare environment/secret names
   and ARNs without printing values.
5. Exercise one authenticated MCP registry/tool flow end to end.

A registered revision, an SSM write or a health endpoint alone is not proof the
API is wired to the running integrations task.

## Rollback

Repoint to a prior image only if its task definition retains the same URL and
shared secret binding. Removing `INTEGRATIONS_URL` and redeploying disables the
API's hosted connector path without changing the secret. Do not delete or
overwrite SSM parameters as a rollback mechanism.
