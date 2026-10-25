# 22. Own Oxy apps use platform authority on the requester's account

Status: accepted, 2026-10-23. Source and published dependency adoption prepared; Alia rollout is still gated.
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
removed. Historical `agent_oxy_app_permissions` rows remain inert migration metadata;
they never authorize execution. Existing
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
API/app typechecking and the API build passed. These were candidate checks;
the registry adoption checkpoint below supersedes their dependency status.
Neither this ADR nor these source commits assert an Alia production rollout.

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
The release checkpoint pins real registry versions: core 7.1.0, contracts 6.0.0,
services 13.0.0, protocol 1.5.1, MCP 1.4.0, Kaana SDK 3.3.0/contracts 8.0.1 and
Clarity SDK 0.10.0. It prepares Alia SDK 22.0.0, server 1.2.0 and Codea CLI 3.0.2 (3.0.1 aligned dependencies in reader phase A).
The SDK passed 877 tests and all 11 isolated entry type checks; the server passed
24 tests/build/entry checks, API voice passed 91 tests and API types passed.
After replacing the last local core artifact with registry 7.1.0, frozen install,
76 CLI tests and 38 audio transport tests passed. No local package path remains.

### API and integrations rollout gate

Historical rollout: producer phase B followed reader A and additive legacy wire A2. It shipped
the final requester/task model and SDK22 while retaining finite process readers
for the old deployment. New producers use only workloads. A2 legacy channel
requests must present their channel's secret plus the actual provider user or
connected-session identity; the API resolves the same live database link and
reconciled task as the workload lane. Account headers never create task authority.

The integrations deployment waits for **this exact commit's** successful API
deployment and verifies the fully drained ECS service against the ECR arm64 image
for that commit. The API post-rollout command reconciles stored, verified Oxy
sessions into tasks; transient failures fail that deployment rather than allowing
the gateway to advance. Links without a valid existing proof resume through the
normal signed-in session, without a consent screen or a fabricated bearer.

Both existing process secrets remain bound during B. Phase C removes dual readers,
the deployment barrier and those inherited secrets only after both producers have
completed and old tasks are gone. SSM removal follows live readback, never precedes
it. See [the exact A/A2/B/C order](../process-reader-transition.md).

Oxy's authority foundation is live. This source change does not assert completed
Alia producer deployment or successful live channel acceptance checks.

### Phase C retirement

The final source removes those finite secret readers and deployment barriers.
HTTP and socket process calls require the exact live receiving workload; former
secrets and raw account headers grant nothing. User/task roots, provider-link
checks, and external provider webhook verification remain. Release C only after
B is verified live in both processes and all old tasks have drained. The removal
is asserted over real HTTP with previously valid secrets, not only source text.

### Retained migration metadata (2026-10-25)

The legacy `agent_oxy_app_permissions` table is retained deliberately as history
of the former agent/app/grant mapping and its timestamps. A source census at
`49bafe68c` found no runtime readers or writers: only the Drizzle definition and
immutable migration snapshots refer to it. Its old enum is now private to that
schema, rather than an exported domain authority model. Existing agent deletion
cascades still remove these rows; retaining them does not preserve deleted users'
data or restore any app permission. No external Oxy grants are changed.

A future retention/export migration may archive or remove this historical table,
but no destructive drop is required to complete the runtime authority cutover.
Deployment acceptance and the final fleet-wide protocol cutover remain separate
from this retention decision.
