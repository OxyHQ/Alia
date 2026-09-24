# 12. Alia uses real models from Oxy's catalogue

*Alia elige modelos reales del catálogo de Oxy.*

**Status:** Accepted

**Date:** 2026-09-25

**Supersedes in part:** [ADR 0002](./0002-alia-is-a-kaana-consumer-and-future-model-publisher.md)
(the routing-profile vocabulary it names as Alia's public identity),
[ADR 0003](./0003-model-revision-deployment-provider-routing-profile.md) (the routing profile
as a product-owned choice a person makes, and the product modes given as its example), and
[ADR 0004](./0004-product-endpoints-versus-generic-inference-endpoints.md) line 49 (*"Alia
does not own a generic model catalogue"*).

## Context

**The owner's decision, 2026-09-25, is the source of this ADR.** Alia has no models of its
own. It is a multi-provider assistant, in the way T3 Chat or Perplexity are: a person picks
a real model — published by a real publisher — and Alia answers with it, through Kaana via
Oxy (ADR 0001, ADR 0010).

What the tree held before this ADR was the opposite. A layer of product vocabulary sat
between the person and the model:

- six **product modes** (`mode:auto`, `mode:instant`, `mode:thinking`, `mode:pro`,
  `mode:code`, `mode:research`) served by `GET /catalogue/modes`;
- thirteen **`route:*` routing profiles**, pinned by hand to opaque Oxy primary keys in
  `packages/api/src/config/oxy-inference-routing-profile-ids.ts`;
- **routing presets** with per-profile credit multipliers (`lib/routing/presets.ts`), a
  per-mode prompt registry (`lib/product-prompt-registry.ts`), a hand-kept per-provider
  reasoning table (`lib/reasoning-effort.ts`), a generated model-mapping table and a
  capabilities table under `internal/providers/lib/`;
- per-plan model allowlists (`plans.model_ids`);
- a `switchModel` tool and an `alia.model_switch` event.

Measured against Oxy, every one of those profiles resolved to the same single model. The
layer did not choose between models; it renamed one, charged for it at six different
multipliers and let the plan table decide which of the six names a person could say. A
person could not select a real model at all — `<publisher>/<model>` was refused at the
request boundary with `unknown_model`.

Meanwhile Oxy already serves what a picker needs. `OxyInferenceClient.listModels()`
(`@oxy.so/core`) returns the catalogue Kaana discovers at its providers and Oxy approves for
Alia, with publisher, capabilities, context window and unit prices, and
`POST /v1/responses` accepts a `model` directly.

## Decision

**Alia names real models, from Oxy's catalogue, and chooses everything else
automatically. Nothing about models is hardcoded.**

### 1. The model identity is `<publisher>/<model>`

A chat request's `model` is a canonical `<publisher>/<model>` from the catalogue, or
`local/<runtime>/<model>` for a model served by the person's own device (ADR 0007).
Absent means the person's default model (§3). Anything else — including every retired
`mode:*` and `route:*` spelling — is refused `400 model_not_found` with `param: "model"`.
There is no product mode, no routing profile, no alias and no "Auto" that is not a model.

### 2. The catalogue is Oxy's, projected for chat

`GET /catalogue` is built from `listModels()`, cached for five minutes, and filtered to what
the chat can use: **text in, text out, and tool calls supported**. Each entry carries the
publisher and model names, context window, maximum output, modalities, tool support, the
reasoning-effort levels the model accepts, its unit prices from Oxy, its release date and
whether it is featured. `GET /v1/models` returns the same list in the OpenAI shape. A model a
provider retires disappears from Alia on the next refresh without a deploy.

### 3. Every choice Alia makes about models is computed

- **Featured** (the picker's first view): for each publisher, its newest chat-usable model,
  ranked by real Alia usage over the last 30 days (`chat_analytics`), top dozen, recomputed
  daily.
- **Default model for a person:** the model they last used; otherwise the most-used
  featured model in Alia; on a cold start, the cheapest featured model with tools.
- **Utility model** (titles, summaries, compaction, suggestions, soul, style refinement,
  planner, verifier and similar internal calls): the cheapest chat-usable model with a
  context window of at least 32k tokens.
- **Speech model:** the cheapest catalogue model with audio output.

No model id appears in code, in environment variables or in a curated list. A persisted
choice (an agent's or thread's `model_id`, a bot's preferred model, a canvas node's model)
is a real `<publisher>/<model>`, and `NULL` means "use the default".

### 4. Reasoning effort is a request parameter, validated against the model

`reasoningEffort` is `low`, `medium` or `high`, accepted only when the chosen model lists
that level in its `reasoningEfforts`, and forwarded to Oxy as `reasoning: { effort }`.
Oxy and Kaana translate it into each provider's dialect. A model without effort levels
takes none; there is no per-provider table in Alia and no "thinking" model name.

### 5. Credits follow real cost; plans differ only in credits

A turn is charged from the model's unit prices as published by Oxy, applied to the metered
units of that turn, converted at one fixed rate (`USD_PER_CREDIT` in
`lib/credits-manager.ts`). There are no per-profile multipliers. Every plan can use every
model; a plan differs from another only by how many credits it grants.

### 6. Prompts follow the surface, not the model

The system prompt is chosen by the surface the turn comes from — chat, Codea, Cowork or
voice — never by the model. The extended-reasoning prompt layer is removed: effort goes to
the model as a parameter.

### 7. What is shown, and what stays hidden

Model and publisher names **are** product vocabulary: the picker, responses and analytics
show them. The **operator serving a deployment** (Groq, Cerebras, OpenRouter and the like)
and **deployment identifiers** remain hidden on the product surface, as before.

## Consequences

- The `mode:*`/`route:*` vocabulary, the Oxy routing-profile ID map, presets, multipliers,
  the prompt registry, the reasoning table, the mapping and capability tables, the
  `switchModel` tool and `GET /catalogue/modes` are deleted. Stored `mode:*`/`route:*`
  values and routing-profile UUIDs are cleared to `NULL` by migration and fall back to the
  default model.
- `agents.routing_profile_id` and `agent_threads.routing_profile_id` become `model_id`;
  `plans.model_ids` and the profile-only `chat_analytics` columns are dropped.
- The catalogue can be empty — Oxy may approve nothing — and Alia then has no model to
  answer with. That is an accurate failure, surfaced as such, not a reason to hardcode a
  fallback.
- Billing now depends on Oxy publishing prices. A model without prices is charged at the
  base token rate and logged; it is not free.
- Clients (app, Codea, Cowork, CLI, SDK) render a model picker grouped by publisher rather
  than a mode picker. That work is outside `packages/api`.

## Alternatives considered

**Keep product modes and map each to a real model.** Rejected. A mode that is a name for one
model is the renaming this ADR removes, and a mode that switches models behind the person's
back is the silent substitution ADR 0003 forbids.

**Environment variables for the default, utility and speech models.** Rejected by the owner:
an env var holding a model id is a curated list of one, it goes stale when a provider
retires the model, and it has to be edited per deployment. Computing from the catalogue has
none of those failure modes.

**Per-plan model allowlists.** Rejected. Cost is already carried by credits priced from the
real model; gating models by plan as well charges twice for the same thing.

## Enforcement

- `packages/api/src/lib/models/__tests__/` covers the pure selection functions (featured,
  default, utility, speech) and the catalogue projection.
- The request boundary (`packages/api/src/lib/chat/request-context.ts`) refuses unknown ids
  and the retired `mode:*`/`route:*` spellings with `model_not_found`, and validates
  `reasoningEffort` against the model, before any credit is reserved.
- Grep gate: `rg "mode:(auto|instant|thinking|pro|code|research)|route:[a-z]" packages/api`
  finds nothing outside historical migrations. It is a review rule, *not yet a CI check*.
