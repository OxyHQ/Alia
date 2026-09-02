# 1. Alia / Oxy / Kaana responsibility boundary

**Status:** Accepted

**Date:** 2026-08-15

## Context

At the time this decision was accepted, Alia also behaved as a generic inference
control plane because product and infrastructure concerns shared the monorepo and
database. The bullets below are the pre-cutover evidence, not current runtime state.

The overlap is concrete, not theoretical:

- Provider adapters, model mappings, key management, health and fallback all live under `packages/api/src/internal/providers/`.
- `packages/api/src/lib/gateway-client.ts:32` computes `GATEWAY_API_ENABLED` from `SERVICE_SECRET` and `GATEWAY_API_URL`, and falls back to direct in-process provider imports whenever either is absent. Production runs the local path.
- Upstream provider credentials are stored in Alia's own database (`provider_keys`, `packages/api/src/db/schema/providers.ts:301`), alongside the routing catalogue (`model_configs`, `alia_models`, `alia_model_provider_mappings`, at `packages/api/src/db/schema/providers.ts:74`, `:155`, `:229`).
- Alia issues its own developer credentials (`developer_apps` and `developer_api_keys`, `packages/api/src/db/schema/developers.ts:37` and `:80`; prefix `alia_sk_` at `packages/api/src/lib/api-key-crypto.ts:21`).
- Alia owns financial records: `plans`, `subscriptions`, `transactions`, `user_credits`, `credit_packages` (`packages/api/src/db/schema/billing.ts:68`, `:262`, `:347`, `:410`, `:208`).
- `POST /alia/chat` and `POST /v1/chat/completions` are the same handler — `packages/api/src/routes/chat.ts:8` dispatches straight to `handleChatCompletions` — so the product runtime and the generic inference surface cannot diverge even where they should.

A product that owns provider credentials, a public inference API, developer identity and a financial ledger cannot be reasoned about, secured or billed independently of the platform it sits on. Every one of those responsibilities has a natural owner elsewhere in the Oxy ecosystem.

Epic #139 sets the target: Alia becomes a consumer of a shared inference platform. Identity, applications, credentials, usage, billing and the public developer experience are owned by Oxy. Provider execution moves behind a separate data plane, **Kaana**.

**Kaana is the inference data plane Alia consumes through Oxy.** Its only canonical signed origin is `https://kaana.ai`; a Kaana host below `oxy.so` is not a compatibility origin. Alia neither signs nor calls Kaana directly. The Alia product remains Alia because agents, conversations, memory, tools and approvals are not provider execution. The ordinary word “relay” in `packages/api/src/lib/mcp-relay.ts` names the unrelated MCP WebSocket transport and is not Kaana.

## Implementation status

The database cut and the inference cut are separate. [PR #465](https://github.com/OxyHQ/Alia/pull/465) completed the PostgreSQL-only runtime: `@alia/api` opens no MongoDB connection and has no Mongo or Mongoose dependency. Before this change, provider adapters and plaintext `provider_keys` rows remained in Alia, and the dormant client/configuration still carried legacy `ALIA_RELAY_*`, `RELAY_BASE_URL`, `X-Oxy-Relay-*` and `oxy-relay-envelope:v1` identifiers. Those identifiers described migration debt, not a supported second name or proof of production cutover.

This change removes that direct hosted runtime and uses the published
`OxyInferenceClient`, but source completion is not production completion. Kaana
has merged PostgreSQL/KMS custody for upstream credentials, including customer
BYOK; the coordinated Alia/Oxy/infra route must still be deployed and live task
definitions proven to contain no provider key before the production cutover can
be claimed.

## Decision

Responsibility is split three ways, and the split is final for the duration of this migration.

**Alia owns the product.**

- Conversations, messages and conversation lifecycle.
- Memory and the context graph.
- Agents, agent teams and agent governance.
- Tools, tool execution and rollback records.
- Approvals and the R0–R3 risk policy.
- Deep research and its progress reporting.
- Triggers, the single scheduling primitive.
- Notifications and product-specific stream events.
- Codea, Cowork, the CLI and app behaviour.
- Product entitlements: plan names, included capabilities, allowances and feature flags, as described in ADR 0005.

**Oxy owns the customer and the platform edge.**

- Accounts.
- Organizations, projects and members.
- Applications and ApplicationCredentials.
- Scopes and permission grants.
- Customer balances, subscriptions, ledger and invoices.
- The public generic inference API and the developer Console.

**Kaana owns inference execution.**

- Request normalization.
- Routing between deployments.
- Provider adapters.
- Streaming.
- Fallback and health.
- Deployments.
- Metering and upstream provider cost.

### Request path

Every model invocation follows one path:

```text
Alia client (app, Codea, Cowork, CLI, SDK)
        │
        ▼
Alia product runtime
  conversations, memory, agents, tools,
  approvals, research, triggers,
  notifications, entitlement checks
        │
        │ Oxy service token
        │ + application / account / credential attribution
        ▼
Oxy inference edge
        │ signed authorized routes
        ▼
Kaana (`https://kaana.ai`)
        │
        ▼
selected model / deployment
```

### Two hard rules

1. **The Alia client never calls a provider directly.** No surface — app, Codea, Cowork, CLI or SDK — holds a provider credential or opens a connection to a provider host. A client talks to the Alia product runtime, and to nothing else for inference.
2. **The Alia backend never bypasses Kaana after cutover.** There is no development bypass, no emergency direct mode and no per-provider exception. When Kaana is unavailable, the product degrades visibly; it does not silently reach around it.

The second rule is what makes the first one durable. A single sanctioned bypass reintroduces the credential, the egress path and the billing ambiguity that the whole migration exists to remove.

## Consequences

- Alia gains an availability dependency on Kaana. Degradation behaviour becomes a product design question rather than an infrastructure accident, and it must be designed explicitly.
- Provider credentials have left Alia's database and deployment environment. The
  legacy `provider_keys` table is removed by post-cutover migration 0057; historical
  migration SQL remains only for upgrade compatibility.
- The routing catalogue tables stop being written by Alia. They become migration inputs, not live state, and are dropped under the gates in workstream 10 of #139.
- Alia's public generic inference surface stops being canonical. ADR 0004 records what happens to `api.alia.onl/v1/*`.
- Alia's financial tables stop being the source of truth for money. ADR 0005 records the split between entitlements and the ledger.
- Attribution becomes explicit. Every inference request carries the Alia application and credential identity, plus optional delegated end-user attribution, so cost centres are separable per surface.
- Product behaviour must be preserved through the move. The migration is not licence to flatten Alia into a chat proxy; the runtime responsibilities listed above stay in Alia.

## Alternatives considered

**Keep provider execution in Alia and let Oxy resell it.** Rejected. It makes a product the generic inference control plane, which is the exact inversion this epic removes. It also leaves provider credentials, resale rights and customer billing tangled inside a product database, where a single product bug is a platform incident.

**Move the whole Alia backend into Kaana.** Rejected. Conversations, memory, prompts and tool state are product data governed by Alia's own privacy behaviour. Placing them in the inference data plane duplicates them into infrastructure that must not retain prompt or response content, and it makes every product change an infrastructure change.

**Run two inference paths — Kaana for new traffic, direct providers for legacy and development.** Rejected. A retained direct path keeps the credential, keeps the egress and keeps the ambiguity about which path a given request took. It also guarantees the direct path is never removed, because it is always the cheaper thing to reach for under pressure. This is the reason rule 2 above is absolute rather than a default.

**Delay the boundary until Kaana is feature-complete.** Rejected. The boundary is a design decision, not a deployment step. Recording it now is what allows the extraction, compatibility and cleanup workstreams to run in parallel without each one re-litigating ownership.

## Enforcement

- **Product code must not import a provider adapter.** An architecture test asserting that no module outside the Kaana client boundary imports from `packages/api/src/internal/providers/**` is *not yet enforced — tracked by #139 workstream 19*. `packages/api/eslint.config.js` carries no `no-restricted-imports` boundary today.
- **No provider hostname outside the Kaana client.** An egress test asserting the Alia service can reach Kaana and Oxy but not provider API hosts is *not yet enforced — tracked by #139 workstream 19*.
- **No provider secret in a public serializer.** A test asserting that no provider secret or hash field is reachable from an admin or diagnostic response is *not yet enforced — tracked by #139 workstream 19*.
- **Code review rule.** Every PR against this epic names its workstream and lists the exact checkboxes it completes. A PR that moves code names the destination path and the removal gate. A PR that adds a provider dependency to product code is rejected on this ADR.
- **Existing partial coverage.** `sanitizeMessage()` (`packages/api/src/lib/errors/sanitize.ts`) and its suite at `packages/api/src/lib/__tests__/sanitize.test.ts` already gate provider detail leaking through error strings. That check survives the migration but is scoped by ADR 0003 and workstream 4: it protects the Alia product surface, not the neutral platform surface.
