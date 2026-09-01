# Runbook: Alia to Kaana cutover

Alia consumes Kaana through Oxy's inference policy boundary. Kaana executes
only the ordered deployments Oxy authorizes; Alia never chooses providers and
never receives an upstream-provider credential.

## Current blocker

Do not cut hosted traffic over yet. The current Alia transport signs and posts
directly to `KAANA_BASE_URL/internal/v1/inference`. Its request builder does not
carry `authorizedRoutes`, while Kaana refuses routing-profile targets unless
Oxy has resolved policy and signed a non-empty ordered list. Oxy's inference edge
already builds that list; no Alia path calls it today.

This blocker must be solved at the boundary, not with a hardcoded provider,
deployment, region, route list or permissive Kaana fallback.

## Configuration contract

The Alia task requires these non-provider values:

```text
KAANA_BASE_URL
KAANA_EDGE_KEY_ID
KAANA_EDGE_SIGNING_PRIVATE_KEY
ALIA_KAANA_ACCOUNT_ID
ALIA_KAANA_APPLICATION_ID
ALIA_KAANA_CREDENTIAL_ID
ALIA_KAANA_ENVIRONMENT
ALIA_KAANA_INFERENCE_SCOPES
ALIA_KAANA_CREDENTIAL_KEY
ALIA_KAANA_CREDENTIAL_SECRET
```

The two `ALIA_KAANA_CREDENTIAL_*` secrets authenticate Alia to Oxy; the edge
private key authenticates an Oxy-signed envelope to Kaana. None is an upstream
provider key. Upstream credentials live encrypted in Kaana's database and must
not appear in this task definition, GitHub repository secrets or Alia's SSM
tree.

The deploy workflow syncs the two Oxy application credentials into exact SSM
parameters and overlays the remaining names onto each task definition. A value
in SSM without a task-definition binding is not delivered. Read back the task
definition the ECS service actually runs; a registered revision that the
service never adopted proves nothing.

## Preconditions

All must pass before a cutover revision is created:

1. Oxy receives the Alia request, authenticates the application credential,
   resolves customer policy and produces non-empty `authorizedRoutes`.
2. The exact envelope bytes delivered to Kaana contain those routes and are
   signed by Oxy after resolution.
3. Kaana validates every route against its published inventory and refuses any
   provider, deployment, model revision or region outside the signed list.
4. Alia has no upstream-provider secret in environment, SSM, GitHub secrets or
   active database rows.
5. Text, tools, image, voice and user-runtime behaviours have explicit coverage;
   unsupported hosted modalities fail with the typed product error.
6. A production canary returns a Kaana start event, usage receipt and the
   expected Oxy account/application attribution.

## Rollout

1. Deploy the Oxy inference-edge path and verify its exact task definition and
   live response first.
2. Deploy Alia with the complete Kaana/Oxy application configuration in one
   immutable revision. The boot guard is fail-closed; there is no enable flag
   and no direct-provider fallback.
3. Verify ECS `runningCount == desiredCount`, the primary rollout is
   `COMPLETED`, and the service points at the intended revision.
4. Run a concrete-model canary and a routing-profile canary. The latter must
   prove a non-empty signed `authorizedRoutes` list without printing it or any
   credential.
5. Verify `/health` reports the `kaana` field and that real inference changes
   connectivity from `unknown` to `reachable`.
6. Only after sustained canaries, remove Alia's legacy provider rows and the
   prior serving path. Deletion is a separate, reviewed migration with a row
   count and backup evidence.

## Rollback

Repoint Alia to the last revision that uses the same Oxy-to-Kaana authorization
contract. Never roll back to an image that reaches an upstream provider or that
accepts provider credentials. If no safe previous revision exists, fix forward
or stop hosted inference visibly.

After repointing, verify task-definition identity, running/desired counts, live
health and a real request. An ECS rollback that merely reaches steady state is
not proof that the intended inference path is serving.
