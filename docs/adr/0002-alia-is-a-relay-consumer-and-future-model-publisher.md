# 2. Alia is a Relay consumer, and a future model publisher

**Status:** Accepted

**Date:** 2026-08-15

## Context

ADR 0001 assigns provider execution to Relay. This ADR settles the two questions that assignment leaves open: what Alia's relationship to Relay is, and what happens if Alia ever ships a model of its own.

Both questions have a wrong answer that is currently easy to reach for.

The first wrong answer is that Alia keeps a small set of adapters "for the cases Relay does not cover yet". Alia owns a full provider stack today — adapters, mappings, key management, health and fallback under `packages/api/src/internal/providers/` — so retaining a subset is a one-line decision at any point during the migration, and each retained adapter carries its own credential and its own egress path.

The second wrong answer is that a future Alia model gets trained, evaluated and released inside this monorepo. Alia already presents thirteen `alia-*` identifiers as models (`packages/api/src/internal/providers/lib/alia-models.ts:63` through `:212`), serialized with `owned_by: 'alia'` at `packages/api/src/routes/v1/models.ts:24`, every one of which routes to a third-party model. The namespace question is therefore not hypothetical: the product has already used Alia-branded model identity for something that is not an Alia model.

Note the two notations are different things and must stay visually distinct. `alia-*` with a hyphen is the current alias set, which ADR 0003 reclassifies and the compatibility window sunsets. `alia/*` with a slash is the publisher namespace in the canonical `<publisher>/<model>` form, reserved here for real artifacts.

## Decision

**Alia is a consumer of Relay. Alia does not own provider adapters.**

- Alia integrates with Relay through one typed client at a single boundary. Product modules import that client and nothing beneath it.
- Alia implements no provider selection. Choosing which deployment serves a request is Relay's responsibility. Alia expresses intent — a concrete model, a revision pin, or a routing profile — and Relay resolves it.
- Alia contributes no adapter code to Relay from this repository. Adapters that must survive the migration are extracted into Relay under workstream 7 of #139 and removed here under that workstream's removal gates.
- No adapter is retained in Alia as a permanent capability. Any transitional shim carries a named owner and a sunset gate, per the compatibility window document.

**Alia may become a model publisher, and publishes through Relay.**

- A real Alia model is published to Relay through the same deployment abstraction every other model uses. There is no privileged Alia serving path, no bespoke Alia inference engine inside the product, and no direct client access to an Alia model that bypasses Relay.
- Training, evaluation, safety review, release manifests, model cards and serving configuration live in a separate private pipeline, working name `OxyHQ/AliaModels`. They never live in this monorepo. A product repository that also holds training artifacts and dataset manifests has neither the access controls nor the release discipline the artifacts require.

**The `alia/*` namespace is reserved as of this ADR.**

Nothing may be published under `alia/*` without all four of the following:

1. **A real artifact.** Weights that exist, are stored, and are addressable. Not a prompt, not a preset, not a routing rule, not a mapping onto somebody else's model.
2. **An immutable revision.** Published as `alia/<model>@<revision>`, with recorded artifact and tokenizer digests, per ADR 0003.
3. **A signed release manifest.** Produced by the release pipeline after capability evaluations, safety and red-team evaluations, and dataset, licence and copyright review have passed.
4. **A model card.** Covering provenance and base-model disclosure, capabilities, limitations and evaluation results.

A reservation with no publication is the point. The namespace exists so that nothing can quietly occupy it, and the four conditions exist so that occupying it means something.

Two corollaries follow directly:

- **An upstream provider mapping may never register under `alia/*`.** That is precisely the mistake the current `alia-*` aliases embody, and repeating it under the canonical namespace would make it permanent.
- **A system prompt, reasoning-effort setting or quality preset never gets its own `alia/*` identifier.** Where the underlying weights are identical, the difference is a runtime parameter or a routing profile, not a model.

## Consequences

- Alia's provider stack becomes strictly transitional. Every module under `packages/api/src/internal/providers/` is on a path to extraction or deletion, and nothing new is added to it.
- Alia loses the ability to add a provider unilaterally. Adding an upstream route becomes a Relay change with a Relay conformance test, which is slower and correct.
- Relay's contract becomes load-bearing for the product. Capability gaps in that contract — tools, structured output, vision, reasoning, prompt caching, modality support — surface as product gaps, so they are tracked as such rather than worked around locally.
- The `alia/*` namespace stays empty until real work is done, so `alia/*` in a catalogue is a truthful signal rather than a brand decoration.
- The current `alia-*` aliases become explicitly not-models. ADR 0003 defines what they are instead, and the compatibility window defines how they are retired.
- A future Alia model release is a pipeline event with review gates, not a deploy of this repository.

## Alternatives considered

**Keep a thin adapter layer in Alia for capabilities Relay does not yet support.** Rejected. It is indistinguishable at runtime from the direct provider mode ADR 0001 forbids, and it recreates the dual-mode ambiguity that `gateway-client.ts` already demonstrates: a facade with a local fallback becomes the local fallback, because the fallback is what runs when configuration is incomplete.

**Publish future Alia models from this monorepo.** Rejected. Dataset manifests, licence records and training provenance need access control and retention rules a product repository does not have, and mixing them makes every product deploy a potential model-governance event.

**Reserve `alia/*` later, at first real release.** Rejected. Reservation is only protective if it precedes the pressure to use the namespace. The current alias set is direct evidence that Alia-branded model identity gets attached to third-party routes when nothing prevents it.

**Serve Alia models on a dedicated Alia-owned inference path.** Rejected. It would give Alia's own models a serving path exempt from Relay's routing, metering and health, which is a second inference control plane wearing a narrower label — and it would break the rule that a model's identity is independent of who serves it (ADR 0003).

## Enforcement

- **No new `alia-*` alias.** A check failing when a new entry is added to `ALIA_MODELS` in `packages/api/src/internal/providers/lib/alia-models.ts` is *not yet enforced — tracked by #139 workstream 19*. Until it lands, the freeze is a code review rule: the alias set is closed, and a PR adding to it is rejected on this ADR.
- **No mapping or preset under `alia/*`.** Validation refusing registration of an upstream provider mapping or prompt preset under the `alia/*` namespace is *not yet enforced — tracked by #139 workstream 19*.
- **No `alia/*` entry in a production catalogue without a signed manifest.** This gate belongs to the release pipeline in `OxyHQ/AliaModels` and to the Relay catalogue, not to this repository. It does not exist yet.
- **No new direct provider import.** Shared with ADR 0001: *not yet enforced — tracked by #139 workstream 19*; enforced by code review in the meantime.
- **Adapter removal gates.** Per provider, workstream 7 of #139 requires the Relay adapter to pass conformance tests, Alia integration tests to pass through Relay, traffic to be canaried, and provider secrets to be removed from Alia before the local adapter is deleted. These are review gates on the extraction PRs; no automated check enforces the ordering.
