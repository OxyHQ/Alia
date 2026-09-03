# 2. Alia is a Kaana consumer, and a future model publisher

**Status:** Accepted

**Date:** 2026-08-15

## Context

ADR 0001 assigns provider execution to Kaana. This ADR settles the two questions that assignment leaves open: what Alia's relationship to Kaana is, and what happens if Alia ever ships a model of its own.

Both questions have a wrong answer that is currently easy to reach for.

The first wrong answer is that Alia keeps a small set of adapters "for the cases Kaana does not cover yet". Before the cutover, Alia owned a full provider stack — adapters, mappings, key management, health and fallback under `packages/api/src/internal/providers/` — so retaining a subset was a one-line decision at any point during the migration, and each retained adapter carried its own credential and egress path. That hosted runtime is now retired; the remaining routing-profile catalogue is product compatibility data, not an execution path.

The second wrong answer is that a future Alia model gets trained, evaluated and released inside this monorepo. Alia previously presented thirteen `alia-*` identifiers as models, each routing to a third-party model. Those aliases are retired, but the namespace lesson remains: the product has already used Alia-branded model identity for something that was not an Alia model.

Note the two notations are different things and must stay visually distinct. `alia-*` with a hyphen is the retired alias set, preserved only in migration history. `alia/*` with a slash is the publisher namespace in the canonical `<publisher>/<model>` form, reserved here for real artifacts.

## Decision

**Alia is a consumer of Kaana. Alia does not own provider adapters.**

- Alia integrates with Kaana through one typed client at a single boundary. Product modules import that client and nothing beneath it.
- Alia implements no provider selection. Choosing which deployment serves a request is Kaana's responsibility. Alia expresses intent — a concrete model, a revision pin, or a routing profile — and Kaana resolves it.
- Alia contributes no adapter code to Kaana from this repository. Adapters that must survive the migration are extracted into Kaana under workstream 7 of #139 and removed here under that workstream's removal gates.
- No adapter is retained in Alia as a permanent capability. Any transitional shim carries a named owner and a sunset gate, per the compatibility window document.

**Alia may become a model publisher, and publishes through Kaana.**

- A real Alia model is published to Kaana through the same deployment abstraction every other model uses. There is no privileged Alia serving path, no bespoke Alia inference engine inside the product, and no direct client access to an Alia model that bypasses Kaana.
- Training, evaluation, safety review, release manifests, model cards and serving configuration live in a separate private pipeline, working name `OxyHQ/AliaModels`. They never live in this monorepo. A product repository that also holds training artifacts and dataset manifests has neither the access controls nor the release discipline the artifacts require.

**The `alia/*` namespace is reserved as of this ADR.**

Nothing may be published under `alia/*` without all four of the following:

1. **A real artifact.** Weights that exist, are stored, and are addressable. Not a prompt, not a preset, not a routing rule, not a mapping onto somebody else's model.
2. **An immutable revision.** Published as `alia/<model>@<revision>`, with recorded artifact and tokenizer digests, per ADR 0003.
3. **A signed release manifest.** Produced by the release pipeline after capability evaluations, safety and red-team evaluations, and dataset, licence and copyright review have passed.
4. **A model card.** Covering provenance and base-model disclosure, capabilities, limitations and evaluation results.

A reservation with no publication is the point. The namespace exists so that nothing can quietly occupy it, and the four conditions exist so that occupying it means something.

Two corollaries follow directly:

- **An upstream provider mapping may never register under `alia/*`.** That is precisely the mistake the retired `alia-*` aliases embodied, and repeating it under the canonical namespace would make it permanent.
- **A system prompt, reasoning-effort setting or quality preset never gets its own `alia/*` identifier.** Where the underlying weights are identical, the difference is a runtime parameter or a routing profile, not a model.

## Consequences

- Alia's hosted provider stack is retired. The compatibility catalogue remaining under `packages/api/src/internal/providers/` contains no credential, adapter or provider egress path.
- Alia loses the ability to add a provider unilaterally. Adding an upstream route becomes a Kaana change with a Kaana conformance test, which is slower and correct.
- Kaana's contract becomes load-bearing for the product. Capability gaps in that contract — tools, structured output, vision, reasoning, prompt caching, modality support — surface as product gaps, so they are tracked as such rather than worked around locally.
- The `alia/*` namespace stays empty until real work is done, so `alia/*` in a catalogue is a truthful signal rather than a brand decoration.
- The former `alia-*` aliases are retired; public routing-profile identity is `kaana-*`.
- A future Alia model release is a pipeline event with review gates, not a deploy of this repository.

## Alternatives considered

**Keep a thin adapter layer in Alia for capabilities Kaana does not yet support.** Rejected. It is indistinguishable at runtime from the direct provider mode ADR 0001 forbids, and it recreates the dual-mode ambiguity that `gateway-client.ts` already demonstrates: a facade with a local fallback becomes the local fallback, because the fallback is what runs when configuration is incomplete.

**Publish future Alia models from this monorepo.** Rejected. Dataset manifests, licence records and training provenance need access control and retention rules a product repository does not have, and mixing them makes every product deploy a potential model-governance event.

**Reserve `alia/*` later, at first real release.** Rejected. Reservation is only protective if it precedes the pressure to use the namespace. The current alias set is direct evidence that Alia-branded model identity gets attached to third-party routes when nothing prevents it.

**Serve Alia models on a dedicated Alia-owned inference path.** Rejected. It would give Alia's own models a serving path exempt from Kaana's routing, metering and health, which is a second inference control plane wearing a narrower label — and it would break the rule that a model's identity is independent of who serves it (ADR 0003).

## Enforcement

- **No new Alia-branded routing alias.** The Kaana-only runtime and catalogue gates reject reintroduction of the retired alias/provider runtime; public routing profiles use `kaana-*`.
- **No mapping or preset under `alia/*`.** Validation refusing registration of an upstream provider mapping or prompt preset under the `alia/*` namespace is *not yet enforced — tracked by #139 workstream 19*.
- **No `alia/*` entry in a production catalogue without a signed manifest.** This gate belongs to the release pipeline in `OxyHQ/AliaModels` and to the Kaana catalogue, not to this repository. It does not exist yet.
- **No new direct provider import.** `kaana-only-runtime.test.ts` freezes the hosted runtime at the Kaana client boundary and rejects direct provider SDK construction/imports there.
- **Provider-runtime retirement.** `hosted-provider-retirement.test.ts` freezes removal of the credential repository, key/fallback/health services, provider admin path and provider-shaped environment variables.
