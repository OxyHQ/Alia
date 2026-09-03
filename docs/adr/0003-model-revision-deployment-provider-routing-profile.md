# 3. Model, revision, deployment, provider and routing profile are five distinct things

**Status:** Accepted

**Date:** 2026-08-15

## Context

Alia currently has one word — "model" — for at least five different concepts, and the resulting confusion is visible in the code.

- `kaana-lite` is a routing policy. `packages/api/src/internal/providers/lib/generate-model-mappings.ts:36` maps that single identifier onto four distinct models from four different publishers, ranked by price and quality. Which one answers a given request depends on health and cost at that instant.
- `kaana-v1-codea` (`packages/api/src/internal/providers/lib/alia-models.ts:89`) and `kaana-v1-thinking` (`:174`) encode a surface preset and a reasoning setting as model identities, even where the underlying weights are unchanged.
- Every one of the thirteen aliases is serialized with `object: 'model'` and `owned_by: 'alia'` (`packages/api/src/routes/v1/models.ts:24`), so a client cannot distinguish a policy from a model at all.
- The provider that operates a deployment is already not always the model's publisher. `generate-model-mappings.ts:164` and `:175` route to deployments operated by one company for models published by another. The code has no vocabulary for that difference; it stores a single `provider` string.
- The storage layer half-knows the distinction and half-does not: `chat_analytics` records both a provider model id and the Alia alias in separate columns (`packages/api/src/db/schema/usage.ts:111` and `:113`), but there is no column for a revision, and no concept of a deployment.
- Fallback across those four different models is invisible to the caller. `docs/model-abstraction.mdx` describes it as transparent escalation, surfaced at most by an optional `alia.model_switch` event (`docs/chat-runtime.mdx:111`). In the vocabulary below, that is silent cross-model substitution.

A catalogue that cannot express these differences cannot be truthful, cannot be billed correctly, and cannot support a user who asks for a specific model and needs to know they got it.

## Decision

Five concepts, five names, no overloading.

### Model

**What it is:** an identity. A named body of work published by an organization.

**Canonical form:** `<publisher>/<model>`.

**Identity rule:** two references denote the same model when the publisher and the model name are equal. Model identity is independent of which revision is current, of who operates the deployment serving it, and of how many deployments exist. Renaming a model creates a different model.

**Example:** `anthropic/claude-opus-4`.

### Model revision

**What it is:** a specific immutable version of a model's artifacts.

**Canonical form:** `<publisher>/<model>@<revision>`.

**Identity rule:** two references denote the same revision when the weights digest and the tokenizer digest are equal. A published revision is never re-pointed at different artifacts. Changing artifacts means publishing a new revision, and the old identifier keeps meaning what it meant.

**Example:** `anthropic/claude-opus-4@<revision>`, where the revision component is opaque and assigned by the publisher's release process. Alia's own future releases follow the same form as `alia/<model>@<revision>`, per ADR 0002.

### Deployment

**What it is:** a servable instance of one revision, running on some infrastructure, in some region, under some capacity and latency characteristics.

**Identity rule:** a deployment has its own identifier and is never addressed by model identity. Several deployments may serve one revision — in different regions, on different runtimes, at different capacities — and doing so does not change the model or the revision being served. Conversely, one deployment serves exactly one revision at a time; pointing it at a different revision is a deployment change that must be observable.

**Example:** two regional deployments serving the same revision, so that a request routed to either receives output from the same artifacts.

### Provider

**What it is:** the operator of a deployment. The party that runs the hardware or the API endpoint.

**Identity rule:** the provider is a property of the deployment, not of the model. The provider is distinct from the model's publisher and may differ from it. For an open-weight model, several unrelated providers may operate deployments of the same revision; the model identity is unchanged by which one serves a request.

**Example:** `generate-model-mappings.ts:175` already routes a model published by one organization to a deployment operated by a different one. Today the code calls both of those "provider"; after this ADR the publisher is the first segment of the model id and the provider is the deployment's operator.

### Routing profile

**What it is:** a product-owned policy that selects among models and deployments on the product's behalf. It is configuration, not an artifact. It has no weights.

**Identity rule:** a routing profile is identified in the product's own namespace and is never expressed in `<publisher>/<model>` form. Two routing profiles are the same when they are the same policy, which is a product configuration question and has nothing to do with artifact digests. A routing profile references models; it never *is* one.

**Example:** the product modes Automatic, Fast, Balanced, Maximum quality, Coding and Deep research. Each names a policy over the catalogue, not a set of weights.

### Invariants

These four rules follow from the definitions and are binding.

1. **A routing profile is never serialized as `object: "model"`.** A catalogue response distinguishes a model from a routing profile in its type, not in a naming convention a client is expected to decode. A client rendering a picker must be able to tell which entries are models and which are policies without heuristics.

2. **A concrete requested model stays concrete through the whole request path.** If a caller requests `<publisher>/<model>`, that identity is what reaches Kaana, what selects the deployment, and what is reported back in usage and analytics. No layer rewrites a concrete request into a different model. A revision pin, where supplied, is equally binding.

3. **Cross-model fallback is an explicit policy, never hidden behaviour.** Substituting one model for another is only permitted when the caller selected a routing profile that allows it, or set an explicit fallback policy that allows it. `no fallback` and `same model only` are supported policies. When a selected concrete model is unavailable and fallback is not permitted, the product reports that clearly and does not answer from a substitute.

4. **Same-model deployment fallback is allowed, and it is Kaana's concern.** Moving a request between deployments of the same revision changes nothing a caller can observe about model identity, so Kaana may do it for health, capacity or latency reasons without product involvement. Alia neither implements nor duplicates that logic.

Invariants 3 and 4 are the same distinction seen from two sides. What makes deployment fallback safe is exactly what makes model fallback unsafe: the first preserves the artifacts that produced the answer, the second does not.

## Consequences

- The current alias set is reclassified rather than renamed. Each `alia-*` identifier becomes either a concrete model reference or a routing profile, and the mapping from old alias to new meaning is part of the compatibility window.
- The catalogue gains a type dimension. Clients — app, Codea, Cowork, CLI and SDK — must render models and routing profiles differently, per workstream 5 of #139.
- Analytics gain precision and lose ambiguity. Recording the requested model or profile alongside the resolved revision makes it answerable, after the fact, which artifacts produced a given response. The present schema cannot answer that question at all.
- Silent escalation across publishers stops. Where that behaviour is still wanted, it becomes a named policy the user or the product opted into.
- Billing gains a stable unit. Cost attaches to a deployment and a revision, not to an alias whose meaning changes with provider health.
- Some requests will now fail that previously returned an answer from a substitute model. That is the intended trade: an accurate failure is more useful than an inaccurate success, and the fallback policy is available to callers who prefer the latter.

## Alternatives considered

**Keep one flat model namespace and encode everything in the identifier.** Rejected. It is what exists today, and it produced an identifier set in which a policy, a preset and a reasoning setting are indistinguishable from a model. Any convention layered on a flat namespace requires every client to parse strings, and parsing conventions drift.

**Treat a deployment as the primary addressable unit.** Rejected. It couples every caller to infrastructure topology, so a capacity change becomes a client-visible change. Callers address models and revisions; Kaana addresses deployments.

**Fold revision into the model identifier and drop the `@` form.** Rejected. Callers who want the current best version and callers who need a pinned artifact are both legitimate, and collapsing them forces one of the two to encode intent out of band. Evaluation and internal builds specifically require pinning.

**Keep silent cross-model fallback for availability, and disclose it only in a stream event.** Rejected. An optional event is not consent. A caller who selected a specific model has stated a requirement, and answering from different weights while reporting the requested name is a correctness failure, not a resilience feature.

## Enforcement

- **No routing profile serialized as a model.** A test failing when a product mode is serialized with `object: "model"` is *not yet enforced — tracked by #139 workstream 19*. Today `packages/api/src/routes/v1/models.ts:24` serializes every entry that way, which is the state this ADR changes.
- **Concrete requests stay concrete.** A contract test asserting that a concrete requested model and a revision pin survive the full request path unchanged is *not yet enforced — tracked by #139 workstream 19*.
- **Fallback policy is honoured.** Enforced at the resolver by `packages/api/src/internal/providers/lib/__tests__/fallback-engine-policy.test.ts`, which drives the real `resolveWithFallback` and asserts which candidates each policy offers, and at the request path by the routing-policy cases in `packages/api/src/routes/v1/__tests__/chat-completions-timeout.test.ts`, which assert the status and message a caller sees and that a retry re-resolves under the same policy. *Still outstanding: an end-to-end test against a live deployment, and same-revision deployment fallback, which is Kaana's under invariant 4 — tracked by #139 workstream 19.*
- **Model versus routing-profile parsing.** A unit test over identifier parsing — including that a routing profile identifier never parses as `<publisher>/<model>` — is *not yet enforced — tracked by #139 workstream 19*.
- **Code review rule.** A PR introducing an identifier that means "a policy" while occupying model-shaped naming is rejected on this ADR, whichever direction it comes from.
