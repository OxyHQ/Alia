# 14. People choose power levels, not models

*Las personas eligen un nivel de potencia, no un modelo.*

**Status:** Accepted

**Date:** 2026-10-01

**Supersedes in part:** [ADR 0012](./0012-alia-uses-real-models.md) — §1 ("there is no
product mode, no routing profile, no alias and no 'Auto' that is not a model"), the
"default model for a person" of §3, and the consequence that clients render a model
picker. The rest of ADR 0012 stands: Alia has no models of its own, nothing about
models is hardcoded, the catalogue is Oxy's, credits follow real cost, the utility and
speech models are computed.

## Context

**The owner's decision, 2026-10-01, is the source of this ADR.** End users of Alia no
longer choose a model by name. They choose a **power level** — Auto (the default),
Instant, Medium, High, XHigh, Pro, Ultra — and the platform chooses the model.

This is not the product-mode layer ADR 0012 removed. That layer was Alia's own: modes
pinned by hand to one opaque Oxy profile each, every one resolving to the same single
model, charged at invented multipliers. Power levels are **Oxy's** (live since
OxyHQ/oxy#1493, `oxy/docs/inference/power-levels.md`): seven routing profiles with
fixed ids in every environment; each level's members are reviewed catalogue data with
a cited benchmark source; Oxy picks an available model of the level (cheapest
first), fails over **across models of the same level**, and names the concrete model
that ran on the response (`model`, `X-Oxy-Model`). `auto` chooses the cheapest level
that suffices for each request and never climbs to `pro` or `ultra`.

Oxy's own guide already says what an assistant should do: *"An assistant where the
user picks 'fast' vs 'smart' → Power level, through Alia. Never show model names."*

## Decision

### 1. A request names a power level, a model, or nothing

A chat request's `model` is one of:

- a **power level** — `auto`, `instant`, `medium`, `high`, `xhigh`, `pro`, `ultra` —
  sent to Oxy as `routingProfile`. What Alia's own app sends;
- a **`<publisher>/<model>`** from the catalogue, for API and SDK callers, operator
  pinned agents and bots (unchanged from ADR 0012);
- **`local/<runtime>/<model>`**, a model on the person's own device (ADR 0007);
- **absent**, which is `auto`.

The seven slugs are Oxy's fixed vocabulary, not a list of models:
`packages/api/src/lib/models/power-levels.ts`.

### 2. The app offers levels, never hosted model names

The composer's mode pill (Bloom `ComposerPanel`'s mode selector: label, short
description, icon per row) lists the seven levels, Auto first. The person's own device
models follow the levels while their device is connected. Working as an agent and
deep research are switches in the add menu. The agent editor offers the same levels;
an agent stored with an exact model shows it as "a pinned model" until a level is
picked.

A stored model choice from before (the old picker, or Alia's older modes) becomes
`auto`; the old `instant` / `max` efforts become `instant` / `ultra`
(`packages/app/src/features/chat/runtime/model-store-migration.ts`).

### 3. Alia does not choose within a level

Alia does not retry, fail over or swap models inside a level: Oxy and Kaana do, along
the routes Oxy signed. Alia reads which model ran from the response
(`providerMetadata.kaana.resolvedModelReference`) and uses it to **price** the turn
(the level itself has no price) and to record `model` in `chat_analytics`; the level
is recorded as the requested model.

### 4. Reasoning effort belongs to the level

Each level carries its own effort at Oxy. The app sends none. An API caller may still
send `reasoningEffort` with a level; Oxy then keeps only the level's models that
accept it.

### 5. What stays exact

Internal calls keep computed exact models (utility, speech — ADR 0012 §3). An agent,
bot or canvas node whose stored model is an exact `<publisher>/<model>` keeps running
on it; one with nothing stored runs `auto`. The product agents Sindi and Clarity store
no model and therefore run `auto`.

## Consequences

- `GET /catalogue` also returns `powerLevels` and `defaultPowerLevel` (`auto`).
  `defaultModelId` remains for clients that still render a model picker (Codea,
  Cowork, the CLI, the SDK, the canvas) as the model to preselect; a request that
  names nothing no longer runs on it.
- The app's model picker, pins, effort control, catalogue client and publisher logos
  are deleted.
- Alia's application policy at Oxy may set `allowedRoutingProfileIds` to the seven
  `power-*` ids and a `defaultTarget` of `power-auto`. Empty means unrestricted, so
  levels work without it; it is an Oxy-side configuration, not an Alia change.

## Alternatives considered

**Keep the model picker and add levels beside it.** Rejected by the owner: users must
not choose models by name.

**Map each level to a model in Alia.** Rejected: that is the renaming ADR 0012 removed,
and it would duplicate Oxy's reviewed membership and failover.

## Enforcement

- `packages/api/src/lib/models/__tests__/power-levels.test.ts` and
  `packages/api/src/lib/inference/__tests__/kaana-language-model.test.ts` (a level is
  sent as `routingProfile`, never as `model`).
- `packages/app/src/features/chat/model/__tests__/power-levels.test.ts` (the app never
  sends a hosted model name) and
  `packages/app/src/features/chat/runtime/__tests__/model-store-migration.test.ts`.
