# 4. Alia product endpoints versus generic inference endpoints

**Status:** Accepted

**Date:** 2026-08-15

## Context

Alia serves two different audiences from one code path.

`POST /alia/chat` is the product runtime used by the app, Codea, Cowork and the CLI. `POST /v1/chat/completions` is presented as a generic OpenAI-compatible inference endpoint for external developers. They are the same handler: `packages/api/src/routes/chat.ts:8` dispatches `/alia/chat` straight to `handleChatCompletions`, and both routers are mounted side by side at `packages/api/src/index.ts:227` and `:228`.

That identity was a deliberate simplification — one runtime, nothing to keep in sync — and it has two consequences that are no longer acceptable.

First, product semantics leak into a surface that claims to be generic. The `/v1` surface carries Alia-specific stream events (`alia.plan_preview`, `alia.approval_request`, `alia.approval_result`, `alia.reasoning`, `alia.tool_result`, `alia.research_progress`, `alia.agent_session`, `alia.title`, `alia.model_switch` — `docs/chat-runtime.mdx:59` onward), memory recall, agent planning and approval pauses. A developer calling an OpenAI-compatible endpoint does not expect a stream that pauses awaiting a human approval decision.

Second, the generic surface carries its own identity and billing stack. `packages/api/src/routes/v1.ts:59` authenticates with `authenticateTokenOrApiKey`, accepting Alia-issued `alia_sk_*` credentials (`packages/api/src/lib/api-key-crypto.ts:21`), rate-limited per key at `:62`, backed by Alia-owned `developer_apps` and `developer_api_keys` tables. Under ADR 0001 none of that belongs to Alia.

ADR 0001 assigns the public generic inference API to Oxy, backed by Kaana. This ADR records what that means for the two endpoints that exist today.

## Decision

### `/alia/chat` is the Alia product runtime

`/alia/chat`, and any successor route that replaces it, is the product surface. It is responsible for, and remains responsible for:

- conversation lifecycle;
- context and memory recall;
- agent planning;
- tool execution and approvals;
- deep-research progress;
- trigger and automation behaviour;
- notifications;
- title generation;
- product-specific SSE events;
- plan and entitlement checks.

None of these move to Kaana. Kaana receives only the context a given inference request requires.

### Generic inference belongs to `api.oxy.so/v1`, backed by Kaana

Alia's `/v1/chat/completions` stops being the canonical generic inference endpoint. A developer who wants generic model access uses Oxy: Oxy Console for applications and credentials, `api.oxy.so/v1` for requests, the Oxy catalogue for models. Alia does not own a generic model catalogue after the Oxy catalogue launches.

### `api.alia.onl/v1/*` is a bounded-window compatibility surface, then it sunsets

Of the three options in workstream 6 of #139 — documented redirect or proxy, bounded compatibility endpoint, or immediate removal with a fixed sunset — the decision is the middle one, with the sunset attached.

`api.alia.onl/v1/*` remains available for a bounded compatibility window, subject to four conditions:

1. **It authenticates through Oxy.** Requests are authorized against Oxy Accounts, Applications and ApplicationCredentials. The compatibility window is a window for *callers*, not for Alia's credential system.
2. **It does not reintroduce Alia-owned API keys.** No new `alia_sk_*` credential is issued for it. Existing credentials are migrated under workstream 11 of #139 and the compatibility window document; the surface does not become a reason to keep issuing them.
3. **It does not reintroduce provider billing in Alia.** Usage on this surface is metered by Kaana and charged through the Oxy ledger, exactly as it would be on `api.oxy.so/v1`. Alia does not settle inference charges for it. See ADR 0005.
4. **It sunsets.** The window is bounded, its deprecation signals and its measurable removal gate are specified in `docs/migration/compatibility-window.md`, and the surface is removed once that gate is satisfied.

Immediate removal was rejected because known external consumers exist and their usage has not been measured; a redirect or transparent proxy was rejected because it preserves the surface indefinitely under a different implementation, which is the outcome the epic exists to avoid.

### Alia-specific SSE events are not part of the generic Oxy inference API

The `alia.*` events listed above are product events. They are not part of the Oxy generic inference contract, they are not implemented by Kaana, and no generic client should be written against them. During the compatibility window they may continue to appear on `api.alia.onl/v1/*` responses, because that surface is the old product runtime under an old name — which is itself a reason the window is bounded rather than open-ended.

One of those events changes meaning under ADR 0003. `alia.model_switch` currently signals a hidden switch between models from different publishers. Under invariant 3 of ADR 0003 that substitution is no longer permitted without an explicit policy, so the event survives only as a signal that an *authorized* route switch occurred.

### The two endpoints must not silently share incompatible semantics

After the split, `/alia/chat` and `api.alia.onl/v1/*` may share implementation, but they must not share it *silently*. A change to product behaviour that alters the generic surface's contract — an added required field, a new pausing event, a changed error shape — is a breaking change to that surface and is treated as one. Where the two contracts genuinely diverge, they get separate handlers rather than a shared handler with conditionals on the caller's identity, because a conditional is exactly how the current identity arose.

## Consequences

- The product runtime is free to evolve product semantics without breaking external developers, once the compatibility window closes.
- Alia's developer-facing documentation changes audience. Generic developers are directed to Oxy Console and `api.oxy.so/v1`; `docs/developers-portal.md` is rewritten or removed under workstream 20 of #139.
- The `alia_sk_*` credential path becomes migration-only. It is not extended, and it is removed on the gate in the compatibility window document.
- Removing `/v1` routes from Alia is not free: `packages/api/src/routes/v1.ts` also mounts `/v1/models`, `/v1/responses`, `/v1/voice`, `/v1/audio`, `/v1/images` and `/v1/shows`. Each is inventoried separately under workstream 1 and carries its own destination and gate; this ADR does not decide them individually.
- The repository already has precedent for clean removal without a shim: `POST /v1/resolve-model` and `POST /v1/report-usage` return `410 Gone` (`packages/api/src/routes/v1.ts`). Compatibility-window removals end the same way, after their gates.
- SDK guidance splits. Product clients use the Alia runtime; generic developers use Oxy. Both must be updated before the window closes, not after.

## Alternatives considered

**Remove `api.alia.onl/v1/*` immediately with a fixed date.** Rejected. Usage has not been measured, and a date is not a gate — the compatibility window document requires measured usage or migrated consumers, never elapsed time alone.

**Keep `api.alia.onl/v1/*` permanently as a product-branded inference API.** Rejected. It reproduces the boundary violation this epic removes: a product operating a generic inference surface, with the credential and billing surface that implies.

**Proxy `api.alia.onl/v1/*` to `api.oxy.so/v1` indefinitely.** Rejected as a permanent arrangement. A transparent proxy keeps the old surface alive with no forcing function to migrate, so the compatibility path never gets removed. A proxy implementation is acceptable *within* the bounded window; what is rejected is treating the proxy as the destination.

**Keep one handler for both surfaces and gate behaviour on the caller's credential type.** Rejected. It is the present design, and it is what allowed product semantics onto the generic surface unnoticed. A conditional on caller identity is a shared contract that nobody reviews as one.

## Enforcement

- **Deprecation signalling on the compatibility surface.** `Deprecation` and `Sunset` response headers and the product stream event are specified in `docs/migration/compatibility-window.md`. No such header is emitted by the API today, and the emission is *not yet enforced — tracked by #139 workstream 19*.
- **No new `alia_sk_*` issuance.** A check failing when a code path issues a new Alia developer credential is *not yet enforced — tracked by #139 workstream 19*. Until then it is a code review rule against `packages/api/src/routes/developer.ts`.
- **Product events absent from the generic contract.** A contract test asserting that no `alia.*` event appears in the Oxy generic inference schema belongs to the Oxy/Kaana contract package and does not exist yet.
- **Divergence is visible.** A contract test over the compatibility surface's request and response shape, run against the product runtime so that a product change altering it fails, is *not yet enforced — tracked by #139 workstream 19*.
- **Usage measurement before removal.** The removal gate for this surface is measured usage, defined in `docs/migration/compatibility-window.md`. Removal without a recorded measurement is rejected in review on that document.
