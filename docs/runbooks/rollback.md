# Runbook: rolling Alia back

A safe rollback restores product behaviour without restoring a direct provider
or direct Kaana path. Alia's hosted inference route is always
`Alia -> OxyInferenceClient -> Oxy -> Kaana`.

## Choose a safe revision

Inspect the candidate task definition and image before repointing. It must:

- contain `OXY_API_URL` and both Oxy ApplicationCredential bindings;
- contain no upstream-provider credential or provider endpoint;
- contain no Kaana URL, signing key or custom signed-envelope transport;
- depend on Oxy policy resolution for routing profiles.

If the candidate violates that boundary, do not deploy it. Fix forward or stop
hosted inference visibly.

## Repoint ECS

Resolve the current service and candidate revision read-only, then update the
service to that exact approved revision. Afterward verify:

- `services[0].taskDefinition` equals the requested revision;
- `runningCount == desiredCount`, desired is positive and `pendingCount == 0`;
- the primary deployment is `COMPLETED`;
- `/health` comes from that image and reports the `kaana` compatibility field;
- one real inference request returns expected Oxy attribution and Kaana usage.

Steady state at zero tasks, a registered-but-unadopted revision, or a health
endpoint without a real inference request are false passes.

## Database migrations

Do not reverse an applied destructive migration by deploying older code.
Migrations `0057` and `0058` rename the active routing-profile schema in `pre`
and remove its rolling compatibility surface in `post`; `0059` removes Alia's
hosted-provider runtime tables. Once those post phases apply, an older image
that queries removed names or tables is not a valid rollback target.

Inspect the migration ledger before any new deploy. Clear an approved pending
phase through the repository migrator, never with ad-hoc SQL.

## Secrets

Rolling Alia back does not rotate its Oxy ApplicationCredential. Rotate it
separately if compromise is suspected. Provider credentials remain owned by
Kaana's PostgreSQL database and must never be recreated in Alia.
