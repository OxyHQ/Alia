# 22. Own Oxy apps use platform authority on the requester's account

Status: accepted, 2026-10-23. Source migration in progress; no release or deployment claim.
Supersedes the own-app levels/grants/ceilings of ADR0015 and ADR0020, following
Oxy ADR0049. External OAuth/MCP connections and domain limits remain separate.

Own products, Alia and agents share the live internal catalogue without scopes,
OAuth consent, or Nada / Ver / Ver y actuar settings. The agent editor retains
primary tool selection and product feature entitlements. Neither is a data grant.

`oxy_*` always binds the verified requester's effective account. An owner and a
stranger using the same public agent each reach their own data; the bot owner's
mail is never a fallback. `self_*` binds only the actor's bot account and is
available only when the original requester may operate it. Oxy rechecks that
relationship. Agent access, application confinement and tool actor declarations
remain enforced.

Every own backend uses attested workload identity, never a customer API key or
an internal shared-secret principal. Oxy customer keys and external OAuth stay
bounded external credentials even when an own backend forwards the call.
Catalogue registrations are pinned by id/version/digest for every transport.

Foreground effects use the verified requester proof. Background goals persist
only an Oxy task id, created while the originating requester is present. Child
runs inherit that task root and its requester, with their actor recorded
separately. Workers never derive the requester from a bot's owner. Cancelling a
root ends its authority; terminal roots retire it and the reaper retries a failed
retirement. Legacy runs with no task proof receive no inferred own-data access.
Structured automations retain their original exact operation authorizations,
resources, limits and idempotency.

The retired app-level routes, editor selectors and persistence writers are
removed. Historical `agent_oxy_app_permissions` rows remain inert until a
coordinated archival migration; they never authorize execution. Existing
external grants are not reclassified or deleted by this change.

No new approval flow is introduced. Existing operation policy and sensitive
limits remain enforced by the relevant product and Oxy. Third-party MCP,
external OAuth providers and connector grants continue through their existing
bounded paths.

Delivery requires Oxy core7/contracts6 candidate validation, publication through
Actions, consumer pins and lockfiles to the published versions, migration and
receiver-first rollout. Track source, package and runtime acceptance separately.

## Implementation and rollout record

Source commits `fc0ef827b`, `c8c9fbfe5` and `bd8e64616` implement workload-only
clients, catalogue-driven own tools, durable requester tasks, managed-account
identity and retirement, and removal of the own-app editor routes/settings.
The historical app-level table is inert; it is not a reason to delete external
OAuth grants. External integrations and local capability families remain governed
by their existing controls.

Validation used locally packed candidate Oxy core/contracts (task API and
`/server/aws`), without committing local package paths. API full suite passed
2,693 tests; focused subsequent managed-account, channel renewal and CAS checks
passed; PostgreSQL passed 43 tests, and the affected app suites passed 85 tests.
API/app typechecking and the API build passed. Consumer manifests still require
the coordinator's published-version update and combined gateway validation.
Neither this ADR nor these source commits assert a production rollout.

Apply the additive schema before readers. Deploy Oxy's task and own-authority
readers before Alia producers; publish dependencies through Actions, pin the
published versions and lockfile, then deploy. Run controlled legacy channel
conversion with the shipped migration entrypoint only after readback and test
acceptance. A person or organization already linked to an external channel can
resume its own task automatically from its normal verified Oxy session; this
adds no internal permission screen and does not reconnect its external provider.

### Shared-client follow-up verification

Alia's receiver now uses its workload-backed Oxy verifier for service tokens
with or without a delegated user. Live service validation never turns a service
owner into a user. External delegation remains scoped and checked by Oxy.
Clarity calls use its product SDK factory; the old catalogue actor compatibility
parser and comments describing own-app levels are removed.

This source checkpoint was tested with packed Oxy core 7/contracts 6 (patched
Zod 4), Kaana SDK 3.3/contracts 8.0.1, and published Clarity SDK 0.10. The full
API run covered 2,705 active tests; its four final fixture failures were resolved
and the three affected suites passed all 11 tests. The revocation-feed fixture
accepts either an already cached first answer or one fresh answer before reuse;
it still requires immediate rejection after session revocation. API types and
build passed. Focused tests exercise actual Clarity SDK mint/refresh/disposal,
verified service signatures, live introspection and external acting-as checks.
These are source checks: published dependency pins, receiver-first deployment
and live acceptance remain required before activation.
