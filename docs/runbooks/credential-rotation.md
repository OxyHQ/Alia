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
| Alia-to-Oxy application key and secret | Oxy ApplicationCredential record -> Oxy provisioner -> `/oxy/alia/OXY_SERVICE_API_*` -> ECS binding | New tasks authenticate with the replacement pair |
| Developer API keys | `developer_api_keys.key_hash` | Revoke the row and issue a replacement; plaintext is never recoverable |
| OAuth and connector tokens | encrypted PostgreSQL columns | API and integrations must share `TOKEN_ENCRYPTION_KEY` |
| Bot/platform tokens | PostgreSQL; encrypted where declared | Restart or reconnect the affected integration |
| Trigger and product webhook secrets | PostgreSQL | Producer and verifier must overlap or switch atomically |

## Alia-to-Oxy application credential

Create the replacement in Oxy with only the scopes the Alia task needs, then run
Oxy's credential provisioner so it writes the pair to Alia's exact SSM
parameters. Do not copy either value into GitHub. Alia's deploy validates only
the parameter names and `SecureString` types, then binds them into a new
immutable task revision without reading or overwriting their values.

Deploy and verify the running task-definition ARN, secret names, positive task
count and a real Oxy-authenticated inference request before revoking the old
credential. Do not print either value. An empty or placeholder secret is not a
rotation.

Alia has no Kaana signing key to rotate. Oxy owns the Oxy-to-Kaana signing
boundary and rotates it independently.

Oxy application events have no Alia-held per-app webhook secret. Migration
`0056` removed the former `oxy_services.webhook_secret` values and retired the
legacy table. Rotate or revoke the publisher's centralized Oxy service
credential in Oxy; do not add a replacement secret to Alia. User-owned
`triggers.webhook_secret` values remain part of the trigger API and must be
rotated with the producer and verifier in agreement.

## `TOKEN_ENCRYPTION_KEY`

The API and integrations service use the same AES-256-GCM key and wire format.
Rotating only one process makes existing encrypted OAuth, connector, bot and
show-ingest values unreadable. Drain work, re-encrypt existing rows through an
explicit migration, then deploy both processes with the new key.

## Verification

Record only identifiers, timestamps and affected row/task counts. Verify the
running revision, not merely an SSM write or registered task definition. A
health probe is insufficient for inference credentials: use one real request
and verify its Oxy attribution and Kaana usage.
