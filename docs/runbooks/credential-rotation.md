# Runbook: rotating and revoking Alia credentials

This runbook covers credentials Alia legitimately owns. Upstream inference
provider keys are explicitly out of scope: Kaana stores them encrypted in its
database, exposes only credential metadata to operators and rotates them through
Kaana's credential-admin role. Never put an upstream provider key in Alia's
environment, SSM tree, GitHub secrets or database.

If an upstream credential is exposed, revoke it at the provider first and use
Kaana's credential incident runbook. Removing it from Alia is cleanup, not
revocation.

## Inventory

| Credential | Owner and storage | Rotation effect |
| --- | --- | --- |
| Alia-to-Oxy application key and secret | GitHub secret → `/oxy/alia/ALIA_KAANA_CREDENTIAL_*` → ECS binding | New tasks authenticate with the replacement pair |
| Kaana edge signing private key | Exact Alia SSM parameter and ECS secret binding | Kaana must trust the corresponding public key before rollout |
| Developer API keys | `developer_api_keys.key_hash` | Revoke the row and issue a replacement; plaintext is never recoverable |
| OAuth and connector tokens | encrypted Postgres columns | API and integrations must share `TOKEN_ENCRYPTION_KEY` |
| Bot/platform tokens | Postgres; encrypted where the schema declares it | Restart or reconnect the affected integration after replacement |
| Webhook secrets | Postgres | Producer and verifier must overlap or switch atomically |
| Process secrets | GitHub/SSM/task definition as declared by the deploy workflow | A value without a live task binding is not delivered |

## Alia-to-Oxy application credential

Create the replacement in Oxy, grant only the scopes the Alia task needs, and
update the two GitHub repository secrets through stdin or the GitHub UI. The
deploy workflow writes them to the exact Alia SSM parameters and overlays those
bindings into the new immutable task revision.

Deploy and verify the running task-definition ARN, secret names, positive task
count and a real Oxy-authenticated request before revoking the old credential.
Do not print either value. An empty or placeholder secret is not a rotation.

## Kaana edge signing key

Generate a new Ed25519 pair outside the repository. Add the public key to
Kaana's trusted edge-key set first. Deliver the private PKCS8 PEM through Alia's
exact SSM secret binding, deploy, and verify a signed canary. Remove the old
public key only after every running Alia task uses the new key.

The private key authorizes signed Oxy inference envelopes; it is not an upstream
provider credential. The envelope must already contain Oxy-resolved
`authorizedRoutes` before it is signed.

## `TOKEN_ENCRYPTION_KEY`

The API and integrations service use the same AES-256-GCM key and wire format.
Rotating only one process makes existing encrypted OAuth, connector, bot and
show-ingest values unreadable. Drain work, re-encrypt existing rows under an
explicit migration, then deploy both processes with the new key. Do not rotate
by overwriting the environment value without a data migration.

## Developer and webhook credentials

Developer API credentials are stored as irreversible hashes: disable the old
row, issue a new credential once, and deliver it to the owner without logging
it. For webhook secrets, arrange a bounded overlap when the remote sender
supports two secrets; otherwise coordinate one atomic switch and monitor
signature failures.

## Verification

For every rotation, record only identifiers, timestamps and affected row/task
counts. Verify the running revision, not merely an SSM write or a registered task
definition. A successful health probe is insufficient for inference
credentials: use one real request and verify its receipt and Oxy attribution.
