# Runbook: upstream provider credential exposure

Kaana is the sole owner of hosted inference provider credentials. Alia has no
provider-key table, endpoint, repository, adapter or environment binding after the
cutover. Revoke or rotate an exposed upstream credential at the provider first, then
follow Kaana's credential-incident procedure. Removing an old value from Alia is only
containment; it cannot revoke a credential or remove it from git history, logs, backups
or replicas.

## Alia history audit

Alia retains a non-secret disclosure ledger because three historical upstream keys were
committed in `keys.json` and the public git history cannot be made private again. Run:

```bash
bun run --filter @alia/api scan:credentials
```

The scanner prints paths, blob identifiers and short prefixes, never secret values.
`packages/api/src/lib/security/known-disclosures.ts` records rotation status. Update its
`rotatedAt` only after the provider confirms revocation. Do not rewrite repository
history: forks, archives, CI caches and existing clones remain exposed.

## Current-state checks

1. In Kaana, identify the credential by metadata without selecting or logging the
   plaintext value.
2. Revoke/rotate it in the upstream provider console.
3. Replace the encrypted Kaana database credential through Kaana's credential-admin
   path and verify a canary through Oxy policy resolution.
4. Search the Alia and Kaana log retention windows for recognizable credential prefixes.
   Any match is another disclosure and requires rotation.
5. Record only identifiers, timestamps and affected counts.

Do not attempt to restore or query Alia's former `provider_keys` table, and do
not run an Alia provider-key script. Post-rollout migration 0061 drops that
duplicate credential store without reading or copying it. Credential recovery,
rotation and incident response now happen only in Kaana.

## Separate credential classes

Developer API keys are irreversible hashes in Alia and are not upstream provider
credentials. OAuth, connector, bot and webhook secrets remain product/integration
credentials. User-supplied local-runtime bindings are also separate: Alia forwards work
to the explicit user compute binding and strips `Authorization`; it does not persist or
reuse a user provider key for hosted inference.
