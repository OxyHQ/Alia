# Kaana client gap analysis

> **Archived pre-cutover analysis.** Every use of “today” or “live” below is
> pinned to the 2026-08-16 measurement and is not a statement about current
> Alia. Current hosted inference is Alia → Oxy → Kaana, and Alia has no provider
> key custody or direct provider adapters. See [`../index.mdx`](../index.mdx)
> and the [responsibility-boundary ADR](../adr/0001-alia-oxy-kaana-responsibility-boundary.md).

The pre-publish half of [issue #139](https://github.com/OxyHQ/Alia/issues/139)
workstream 3, *"Introduce a typed Kaana client boundary"*.

For every capability that workstream lists under **Client responsibilities** and
**Resilience**, this document states three things: what the Oxy↔Kaana contract
defines for it, what Alia's live path does today, and the exact edit that bridges
them. The goal is that the work after `@oxyhq/contracts` publishes its inference
module is mechanical rather than exploratory.

**Measured 2026-08-16.** Alia paths are `packages/api/src/…` on
`epic139/ws3-kaana-seam`, based on `main` at `bd7d281e`. Contract paths are
`packages/contracts/src/inference/…` in
[OxyHQ/oxy](https://github.com/OxyHQ/oxy) at `origin/main`, read through
`git show` only. Oxy API paths are `packages/api/src/…` in the same repository.

Alia files are cited by basename after §2 gives each one's full path. One
basename collides: every `model-config.ts` below is `lib/chat/model-config.ts`,
never `domain/model-config.ts`.

---

## 0. The blocker, and what it costs

`@oxyhq/contracts@0.26.0` is the latest published version and it does **not**
contain the inference module — it was cut before that work merged.

Measured from the published tarball, each count paired with a positive control so
that a zero means absence rather than a scan that read nothing:

| measurement | result | positive control on the same artefact |
| --- | --- | --- |
| files matching `inference` in the tarball | **0** | 6 files match `session` |
| inference symbols in `dist/types/index.d.ts` | **0** | 51 `export` lines in the same file |

`packages/contracts/package.json` on `origin/main` also reads `0.26.0` — the same
version that is already published — so a republish is a version bump plus a
publish, not a publish alone.

**Therefore Alia adds no `@oxyhq/contracts` dependency in this workstream.**
Adding it today would resolve to a package whose inference module does not exist,
and every type below would silently become an import error or, worse, an `any`.

**And Alia writes no local copy of a contract type.** Not as an interface, not as
a type alias, not temporarily. A mirrored type set is precisely the drift the
epic's own checkbox — *"Shared stream/request types come from the contracts
package, not local copies"* — exists to prevent, and "temporarily" is how one
arrives. The seam in §4 holds every payload position open as a type parameter
instead, and `packages/api/src/lib/inference/__tests__/product-seam.test.ts`
fails if any of them is replaced by a declared shape.

---

## 1. What must NOT be built

Recorded first, because it is the part a reader is most likely to rediscover the
hard way.

### There is no mounted inference edge on the Oxy side

`Oxy API → Kaana` does not exist in any form. Any Alia work that assumes it does
is building against a hole.

- Oxy's `packages/api/src/server.ts:647` mounts `/v1` on `aliaRoutes` with only
  `userRateLimiter`. Of the 155 route files under `packages/api/src/routes/`,
  **zero** match `inference` or `kaana` (positive control: 155 match `a`, so the
  listing is reading files). The one occurrence of "kaana" in `server.ts` is at
  line 673 and refers to the E2E-encrypted device-transfer kaana — an identity
  feature, unrelated to inference.
- `POST /v1/chat/completions` on Oxy is still the old static-key proxy:
  `packages/api/src/routes/alia.ts:65` gates on `authMiddleware` alone, then
  `axios.post` to `https://api.alia.onl/v1/chat/completions` with
  `Authorization: Bearer ${ALIA_API_KEY}` (`alia.ts:7-8`, `:75-79`).

**So the arrow points the wrong way today.** The target architecture is
`Alia backend → Kaana`; the only live coupling is `Oxy → Alia`, and Alia is the
data plane in it.

### Mounting the machine credential on that route is explicitly blocked

[OxyHQ/oxy#981](https://github.com/OxyHQ/oxy/issues/981) (OPEN as of
2026-08-16) records that the route is reachable by any signed-in Oxy user, bills
one shared `ALIA_API_KEY`, and that nothing reserves or meters the spend. It
states that #980 deliberately does not mount the new `oxy_sk_*` machine
credential on it, because "a long-lived, programmatically-issued key on an
unmetered endpoint is the same hole with a wider door."

**Consequences for Alia:**

- Do not build a Kaana HTTP client against a URL. There is nothing to point it
  at, and inventing a base URL produces a client whose first real test is
  production.
- Do not build reservation, settlement or receipt handling that assumes Oxy
  answers. §3.7–§3.9 below say what Alia must be *ready* to send; sending it
  requires the Oxy ledger that #972 workstream 7 supplies.
- Do not treat Alia's `/v1/chat/completions` as the thing being replaced by
  Oxy's. They are two different endpoints that happen to share a path: Oxy's is
  a proxy *into* Alia, Alia's is the product runtime. #139 workstream 6 splits
  Alia's; #972 workstream 4 replaces Oxy's.

---

## 2. The live path, once

Every claim in §3 refers to this path. `/v1/chat/completions` is the only
streaming caller; the other 31 modules that import `chat-core.ts` are
non-streaming and take the same first three steps.

```
routes/v1/chat-completions.ts:29   handleChatCompletions
  ├─ :31                           requestId = `chatcmpl-${crypto.randomUUID()}`
  ├─ :44-63                        GLOBAL_TIMEOUT_MS = 80_000, synthetic reply on fire
  ├─ :68  lib/chat/request-context.ts:80    validate, prefetch, reserve credits, resolve model
  │        ├─ :136-138                      routingOptions from body.fallbackPolicy
  │        ├─ :185   lib/credits-manager.ts:88   reserveCredits(userId)  ← no amount
  │        └─ :201   lib/chat-core.ts:60         resolveModel → lib/gateway-client.ts:309
  │                                              → internal/providers/lib/model-resolver.js
  └─ :243 lib/chat/provider-loop.ts:106     runProviderLoop
           ├─ :127                          MAX_PROVIDER_RETRIES = max(tierMappings, 5)
           ├─ :168 lib/chat/model-config.ts:51   buildBaseConfig
           │        ├─ :54                       getAIModel(resolved.keyConfig)  ← raw provider key
           │        ├─ :63                       maxRetries: 0
           │        ├─ :66                       stopWhen: stepCountIs(5)
           │        └─ :116-125                  first-byte 20s AbortController
           ├─ :210                          streamText(baseConfig)
           ├─ :222 lib/chat/stream-runner.ts:127  runStream — chunk → OpenAI SSE
           ├─ :295 lib/chat-lifecycle.ts          finalizeChatCredits
           └─ :349-392                      classify, skip key vs provider, retry
```

---

## 3. Client responsibilities

### 3.1 Authenticate using Oxy service tokens

**Contract.** `attribution.ts:86-92` — `authenticatedPrincipalSchema` is what a
verified Oxy service token carries, resolved by the Oxy edge *before* the request
is forwarded: `billing`, `applicationId`, `credentialId`, `environment`,
`inferenceScopes`. `attribution.ts:49-57` closes the scope set to seven
`inference:*` values.

**Alia today.** No counterpart at any level. `gateway-client.ts:32-34` reads
`SERVICE_SECRET` and `GATEWAY_API_URL`; when both are set it signs requests with
an HMAC over `timestamp + service + method + path + sha256(body)`
(`gateway-client.ts:64-77`). Production sets only `SERVICE_SECRET`, so
`GATEWAY_API_ENABLED` is false and every branch takes the local in-process path
(`AGENTS.md`, "Gateway and provider keys"). There is no token exchange, no
`environment`, and no scope concept.

**Edit.** Delete `generateAuthHeaders`, `apiGet`, `apiPost`, `apiPatch` and the
mode detection (`gateway-client.ts:30-132`) as one unit — the HMAC mode is the
"static cross-service secret" workstream 2 removes. The replacement obtains a
short-lived service token through `@oxyhq/core` and lets the Oxy edge resolve
`AuthenticatedPrincipal`; Alia never constructs one, because it cannot: the
brands in `identifiers.ts:38,50` mean the only way to obtain an `OxyAccountId` is
to parse one through the schema.

**Since 2026-08-17 (#139 ws2).** The replacement half of that edit exists:
`lib/inference/kaana-credential.ts` configures `@oxyhq/core` with the
ApplicationCredential in `OXY_SERVICE_API_KEY` / `OXY_SERVICE_API_SECRET`
and returns it typed as `RelayClientConfig['credential']`, so the token the
client presents is minted, cached and refreshed by the SDK — measured against a
real `/auth/service-token` round trip in `__tests__/kaana-credential.test.ts`.
`kaanaBootConfigurationFailure` refuses to start a flag-on process that has no
credential. **The DELETION half has not happened**: `gateway-client.ts` still
carries the HMAC mode, because removing it means moving the live path, which is
workstream 8's cutover and not this one's.

### 3.2 Attach applicationId, credentialId, owner attribution and delegated user

**Contract.** `attribution.ts:107-112` — every request, receipt and ledger record
carries `principal`, optional delegated `userId`, `requestId`, optional
`generationId`. `attribution.ts:70-74` makes `billingPrincipalSchema` `.strict()`
with exactly one field, and `identifiers.ts:38,50` give `oxyAccountIdSchema` and
`delegatedUserIdSchema` **different brands**, so a delegated user cannot become
the payer in either direction without a cast.

**Alia today.** Alia has only the delegated half. `req.user.id` reaches the
resolver path but is never attached to anything the resolver sends
(`request-context.ts:183-190`, `:201`). There is no account, application,
credential or environment anywhere on the inference path. `requestId` exists but
is generated by the *product* (`chat-completions.ts:31`) and is used solely as
the `id` field of OpenAI SSE chunks — it never crosses `gateway-client.ts`.

**Edit.** The seam's `AliaInferenceCaller.oxyUserId` becomes the contract's
delegated `userId` and nothing else. The Kaana client attaches the principal from
its own configured credential. **`requestId` reverses direction**: the contract
generates it in the data plane (`identifiers.ts:63-68`) and puts it on every
stream event, so `chat-completions.ts:31` stops being the origin and becomes a
consumer — Alia's `chatcmpl-…` id survives only as the OpenAI-dialect chunk id it
already is, and is no longer the correlation key.

### 3.3 Support `POST /responses`-style normalized requests

**Contract.** `request.ts:268-305` — one envelope: `schemaVersion`,
`attribution`, `target`, `modality`, `input`, `stream`, `maxOutputTokens`,
`sampling`, `tools`, `toolChoice`, `responseFormat`, `client`,
`idempotencyKey`, `routingPolicy`. `request.ts:147-161` gives `input` three
formats (`messages`, `text`, `text_batch`) because an embedding batch boundary is
not recoverable from a one-message conversation.

**Alia today.** No normalized envelope exists. `buildBaseConfig`
(`model-config.ts:51-127`) assembles an AI SDK config object typed `any` —
explicitly, with an eslint suppression at `model-config.ts:44-45` and again at
`:57` — and mutates it in place with provider-specific keys
(`experimental_thinking` at `:88`, `experimental_providerMetadata` at `:102`).
The messages it carries were converted by
`lib/message-converter.ts` into AI SDK shape, not into a normalized one.

**Edit.** `buildBaseConfig` becomes a translator from Alia's request body to
`InferenceRequest`, and its return type stops being `any`. `temperature`,
`max_tokens`, `stop` move into `sampling`/`maxOutputTokens`
(`request.ts:168-179`, `:277`). The two `experimental_*` mutations have no
contract counterpart and are handled in §3.11.

### 3.4 OpenAI-compatible chat requests as an adapter at the boundary only

**Contract.** `request.ts:234-254` — `client.apiFormat` records which public
dialect the customer used, from a closed list including `chat_completions`,
because the response has to be rendered back in it. The normalization happens
once, at the edge.

**Alia today.** The dialect is not recorded, it is *pervasive*. The OpenAI wire
shape is constructed in at least four places on the streaming path:
`stream-runner.ts:195-199` (tool-call delta), `:283` and `lib/streaming-helpers.ts`
(`writeTextChunk`, `writeStopChunk`, `writeContentChunk`, `makeChunk`),
`provider-loop.ts:296-321` (the terminal usage chunk), and
`lib/chat/response-shapes.ts` (`buildCompletionResponse`, used by the synthetic
replies at `chat-completions.ts:50` and `:290`).

**Edit.** Those four become one renderer that consumes `InferenceStreamEvent` and
emits OpenAI frames, sitting *above* the Kaana client. Set
`client.apiFormat: 'chat_completions'` and `client.endpoint: '/v1/chat/completions'`
in the translator from §3.3. This is the single largest mechanical edit in the
workstream and it is confined to `lib/chat/` plus `lib/streaming-helpers.ts`.

### 3.5 Streaming SSE / event translation

**Contract.** `streamEvents.ts:228-236` — seven event types in one discriminated
union on `type`, each carrying `requestId` and a monotonic `sequence`. The
union's own doc states the intent: a consumer meeting an unknown event **fails at
the parse** rather than falling into a default branch that treats it as output.

**Alia today.** `runStream` (`stream-runner.ts:143-374`) dispatches on the AI
SDK's chunk types and ends with an `else` branch that logs `'Unhandled chunk
type'` and continues (`:371-373`) — the exact permissive default the contract
refuses. The mapping is not one-to-one in either direction:

| contract event | Alia today |
| --- | --- |
| `start` | none — no event marks the resolved model |
| `delta` (`output_text`) | `stream-runner.ts:171` `writeTextChunk` |
| `delta` (`reasoning`) | `:164` and `:182`, as the `alia.reasoning` extension |
| `delta` (`refusal`) | none — a refusal arrives as ordinary text |
| `tool_call` | `:195-199`, as an OpenAI `tool_calls` delta |
| `usage` | one terminal chunk only, `provider-loop.ts:296-321` |
| `route_switch` | **none** — see §3.10 |
| `error` | `:297-366`, and usually not surfaced at all — see §3.12 |
| `done` | `:367-370` `writeStopChunk`, then `provider-loop.ts:338` `[DONE]` |

**Edit.** Replace the AI SDK dispatch with a dispatch over
`InferenceStreamEvent`, and make the final branch throw rather than log. Three
contract events have no Alia consumer yet and need one built: `start`
(§3.6), `usage` (§3.8) and `route_switch` (§3.10).

### 3.6 Preserve request IDs and generation IDs

**Contract.** `identifiers.ts:63-74` — both are generated by the data plane.
`requestId` is on every stream event and every ledger record; `generationId` is
present once a generation exists and is what `GET /v1/generations/:id` looks up.
`streamEvents.ts:45-56` puts `generationId` on `start`, `:210-220` on `done`.

**Alia today.** `requestId` is Alia's own (§3.2). **There is no generation id
concept at all** — the string `generationId` does not appear in
`packages/api/src`.

**Edit.** Read `requestId` and `generationId` off the `start` event and store them
on the conversation turn. `lib/conversation-saver.ts` and
`saveConversationResult` (`chat-lifecycle.ts`) are the two writers that need the
extra columns; without them a user's message has no handle on the generation that
produced it and no receipt can be reconciled back to a turn.

### 3.7 Preserve usage receipts and route metadata

**Contract.** `usage.ts:209-246` — the receipt is immutable and carries
`units`, `usageSource`, a **copy** of the `priceSnapshot`, `billedAmount`,
`currency`, `platformFeeOnly`, `resolvedModelReference`, `servingProvider`.
`streamEvents.ts:218` puts `receiptId` on the `done` event once settlement has
produced one. `money.ts:68-74` makes every amount an exact decimal **string**,
branded, with no exponent form.

**Alia today.** **No counterpart, in either direction.** Alia has no receipt, no
price version, no currency and no settled record of an inference call. The
nearest thing is `alia_usage` on the terminal SSE chunk
(`provider-loop.ts:312-318`): `system_prompt_tokens`, `billable_tokens`,
`credits_charged`, `credits_remaining`, `credit_warning`. Those are **product
entitlement units**, not money — and they are JS numbers
(`credits-manager.ts:18-30`), which the contract forbids for anything
financial.

**Edit.** None yet, and this is a place to *not* build. Receipts require the Oxy
ledger (#972 workstream 7). What Alia does now is keep credits and money apart —
which #139 workstream 12 owns — so that when a receipt arrives it is stored
beside the turn rather than converted into credits. The seam deliberately carries
no money type for the same reason.

### 3.8 Normalize typed errors without leaking credentials or unsafe internals

**Contract.** `errors.ts:38-65` — 26 closed codes.
`errors.ts:78-98` names 19 as never-retryable and `errors.ts:191-198` makes
`retryable: true` on one of them a **parse failure**, so an optimistic producer
cannot arm a retry storm. `errors.ts:118-125` refuses free text that matches a
credential marker, applied to Oxy's message and the upstream's alike.
`errors.ts:156-166` is a `.strict()` four-field provider passthrough with no room
for headers or a body.

**Alia today.** Two overlapping taxonomies, neither aligned to the contract:
`FailoverReason` — 8 values (`error-codes.ts:19-27`) — drives retry decisions,
and `AliaErrorCode` — 11 values (`error-codes.ts:31-54`) — drives HTTP status
(`:58-70`) and the user-facing string (`:75-98`). `retryable` is a free boolean
on `AliaErrorParams` (`:108`) with nothing constraining it against the code.

**Edit.** Map `FailoverReason` onto `InferenceErrorCode` at the boundary and
delete the Alia-side classification of *provider* failures — `classifyError`
inspects provider error shapes, which is Kaana's job once Kaana reports a typed
code. `AliaErrorCode` survives as the **product** error set (`CREDITS_INSUFFICIENT`
has no contract counterpart and should not get one).

Two traps here:

1. **`sanitizeMessage` currently sits at the transport boundary, and must move to
   the render boundary.** It replaces every registered provider name with the
   literal `"Alia"` via an unanchored case-insensitive regex
   (`lib/errors/sanitize.ts:24-34`). The contract *requires* naming the provider
   in `providerError.provider` (`errors.ts:158`). Those are not in conflict —
   the contract carries provider identity as data, Alia's rule governs what is
   *rendered* — but only if the sanitiser stops running on the wire object.
   Running it there would corrupt a field the contract needs and would still not
   be a security control.
2. The same unanchored regex meant a user's own text was rewritten: `llama` was
   on the pattern list and is an ordinary Spanish word, and Alia answers in
   Spanish. **Fixed by workstream 20**, which scoped concealment to identifiers
   and proper nouns and gated it on the shipped `es.json`. Trap 1 is unaffected:
   the sanitiser still must not run on the wire object.

### 3.9 Tools, structured output, vision, reasoning, prompt caching, modalities

**Contract.** `request.ts:186-215` — `toolDefinitionSchema` carries `parameters`
as an opaque JSON Schema object (validating it against a meta-schema would reject
documents providers accept), `toolChoiceSchema`, and `responseFormatSchema` with
`text` / `json_object` / `json_schema`. `catalogue.ts:66-80` declares the
capability flags a caller decides against, including `promptCaching` and
`reasoning`.

**Alia today.** Tools reach the model through `ToolPipeline.forUser`
(`chat-completions.ts:101-110`) and `wrapToolsWithTruncation`
(`:224`) as AI SDK `ToolSet` objects with executable bodies. Structured output is
`generateObject` at two call sites (`lib/agent/planner-agent.ts`,
`lib/agent/verifier-agent.ts`). Reasoning is provider-conditional
(`model-config.ts:87-99`). **Prompt caching has no representation anywhere** —
the terminal usage chunk hardcodes `cached_tokens: 0`
(`provider-loop.ts:309`).

**Edit.** Split each Alia tool into its **definition** (crosses the seam as
`ToolDefinition`) and its **executor** (stays in Alia — the contract has no place
for an executable body, and correctly so). The multi-step loop is Alia's: see
§4.2. `generateObject`'s schema becomes `responseFormat: json_schema`, and both
call sites parse the returned text themselves. `cached_tokens` stops being a
hardcoded zero and becomes the `cached_input_tokens` unit (`money.ts:106`).

### 3.10 Routing policy, model pinning, deployment fallback, route-switch events

This is where Alia and the contract disagree most, so it is stated in four parts.

**Contract.** `routingPolicy.ts:46-59` splits the target structurally: `model`
(serve *this* one) versus `routing_profile` (choose for me).
`routingPolicy.ts:87-93` makes cross-model fallback an explicit **list of model
references**, never a boolean, "because 'allow fallback' without naming the
destination is exactly the silent substitution the invariant forbids".
`streamEvents.ts:123-150` makes a `scope: 'model'` switch constructible **only**
with `authorizedByPolicy: z.literal(true)`. `routingPolicy.ts:236-241` records
`{routingPolicyId, policyVersion}` on the request so a months-old decision stays
explainable.

**Alia today.**

1. **The target distinction does not exist.** Every request names an `alia-*`
   alias (`request-context.ts:161`), which is a routing profile presented as a
   model — the thing #139 workstream 4 removes.
2. **Cross-model fallback is the default and is a boolean-shaped choice.**
   `DEFAULT_FALLBACK_POLICY = 'cross-model'` (`lib/routing/policy.ts:59`), and
   `'cross-model'` means "the whole ranked list, publishers included"
   (`policy.ts:29`) — a list Alia holds, not one the caller named.
3. **A switch is invisible to the caller.** `provider-loop.ts:147` re-resolves to
   a different provider and concrete model, and every subsequent SSE chunk still
   reports the unchanged alias (`stream-runner.ts` writes `aliasModelId`
   throughout). The information exists: `isFallback` and `fallbackIndex` are
   computed at `internal/providers/lib/fallback-engine.ts:445-454` and carried
   through `model-resolver.ts:27-28` → `gateway-client.ts:185` →
   `chat-core.ts:44-45`. **Outside `internal/providers/` nothing reads either
   field.** It reaches an internal telemetry row only
   (`fallback-engine.ts:431-524` → `fallback_events`).
4. **`ROUTING_POLICY_VERSION = 1`** (`policy.ts:71`) is the nearest counterpart to
   `policyVersion`, but there is no `routingPolicyId`: Alia has one global
   policy, not a per-account configuration.

**Edit.** `AliaModelChoice` (§4) crosses the seam and the Kaana client turns it
into a `RoutingTarget`. The re-resolve loop at `provider-loop.ts:134-154` is
**deleted**, not ported: choosing a different provider is Kaana's, and keeping a
copy in Alia is the "no local/direct provider fallback remains" invariant
failing. In its place, subscribe to `route_switch` and surface it — that is a new
Alia SSE event and a new UI affordance, and it does not exist today.

> **Trap.** Alia already emits `alia.model_switch`
> (`lib/tool-pipeline.ts:122`, declared at `lib/chat-events.ts:12`). It is **not**
> a route switch. It fires when the model calls the `switchModel` tool
> (`lib/tools/switch-model.ts`) to change the conversation's Alia model — a
> deliberate, user-visible product feature. Mapping the contract's `route_switch`
> onto it would turn a failover notice into a model-picker change in the user's
> UI. They need two different event names.

### 3.11 Never implement provider selection inside the Alia client

**Contract.** The whole of `routingPolicy.ts` and `catalogue.ts` lives on the Oxy
side; `providerConnection.ts:64-70` makes even a credential a `<store>:<locator>`
**reference**, "never credential material", resolved in the data plane at use
time.

**Alia today.** Alia does provider selection, and it hands the result to product
code. `getAIModel(keyConfig)` (`chat-core.ts:116-204`) is a 19-arm switch that
constructs a provider SDK client from `keyConfig.key` — a **live upstream API
key** (`gateway-client.ts:140`) — and hardcodes 16 provider base URLs. Measured
over the 32 non-test modules that import `chat-core.ts`:

| symbol | importers |
| --- | --- |
| `resolveModel` | 26 |
| `getAIModel` | 24 |
| `getDefaultAliaModel` | 16 |
| `reportModelUsage` | 6 |

**24 product modules receive a live provider credential today.**

**Edit.** `getAIModel` is deleted outright. `resolveModel` is deleted and its 26
importers move to the seam's `generate`/`stream`, which return no provider handle
and no key — after cutover a product module *cannot* name a provider, because
nothing on the interface returns one. `getProviderTimeout`
(`gateway-client.ts:346-348`) has exactly one caller, `lib/synthesize-speech.ts:58`,
and goes with the TTS extraction in workstream 7.

### 3.12 Two provider behaviours the contract has no place for

Recorded here rather than under "what Alia does extra" (§5) because they are on
the request path and will be silently dropped at cutover if nobody names them.

- **`maxRetries: 0`** (`model-config.ts:63`) deliberately disables the AI SDK's
  own retry so failures reach Alia's application-level loop. Once that loop is
  deleted (§3.10), retry policy is entirely Kaana's and this line has nowhere to
  go — which is correct, but it means Alia loses its ability to observe an
  attempt.
- **The in-stream synthesis retry** (`stream-runner.ts:315-356`): when a provider
  errors after emitting tool results but no text, Alia re-issues the whole
  request with the tool results appended and `tools: undefined`, on a fresh
  30-second abort. This is a **second inference call** billed as part of one
  turn. Under the contract it is unambiguously two requests with two receipts,
  and the second one needs its own `idempotencyKey`.

---

## 4. Resilience

### 4.1 Connect, first-byte, idle-stream and total timeouts

**Contract.** Silent — no timeout shape exists in any of the twelve contract
files. This is a genuine gap in *both* directions: the epic asks Alia to define
these, and there is nothing to align them against. The seam carries them.

**Alia today.** Four unrelated constants in three files, and one missing:

| budget | today |
| --- | --- |
| connect | **none** on the chat path |
| first token | 20 s, `model-config.ts:116-123` |
| idle stream | **none** — see below |
| total | 80 s, `chat-completions.ts:44` |
| (synthesis retry) | 30 s, `stream-runner.ts:330` |
| (non-chat provider call) | 15 s, or 120 s for `fal-ai/`, `gateway-client.ts:346-348` |

The idle-stream gap is real and reachable: the first-byte timer is cleared on the
first chunk (`stream-runner.ts:146` → `model-config.ts:125`) and **nothing
re-arms it**, so a stream that delivers one token and then stalls runs to the 80 s
global timeout with the connection held open.

**Edit.** `AliaInferenceBudget` (§5) becomes a property of the call, so a 3-second
title generation and an 80-second chat turn stop sharing a number. Add the
idle-stream timer — that is a bug fix, not a port.

### 4.2 Safe retry rules; never double-charge or duplicate tool effects

**Contract.** `request.ts:283-284` carries an optional `idempotencyKey`, present
"when the operation is safe to deduplicate on retry". `usage.ts` keys every
reservation, receipt and refund on one (`:68`, `:216`, `:296`), so a retried call,
a redelivered event or a duplicated webhook produces the same record rather than a
second charge. `errors.ts:78-98` makes non-retryability a property of the code.

**Alia today.** **No idempotency key exists on the inference path.** All 16
occurrences of `idempotenc*` in `packages/api/src` are webhook, seed or moderation
concerns (positive control: 163 occurrences of `reservation` in the same scan, so
the scan sees the tree).

Alia's protection against duplicate tool effects is instead structural, and it
holds: the loop only retries when `!streamState.hasStreamedContent`
(`provider-loop.ts:367`), and `hasStreamedContent` is set to `true` the moment a
`tool-call` chunk arrives (`stream-runner.ts:187`) — before the tool executes. So
a tool effect blocks the retry. Worth stating plainly because it is easy to
mistake for an accident and delete.

**Edit.** Generate one idempotency key per *logical* turn and pass it on the
request. The synthesis retry (§3.12) needs a **different** key, because it is a
different operation. Retryability stops being Alia's judgement and becomes
`InferenceError.retryable`; delete `NON_RETRYABLE_STREAM`
(`provider-loop.ts:51`) and `KEY_LEVEL_REASONS` (`:132`), both of which reason
about providers.

### 4.3 The reservation is the sharpest mismatch on this page

**Contract.** `usage.ts:65-79` — a reservation holds the **maximum** a request
could cost, computed from three named inputs: the units already known (the
prompt), the ceiling on units still to come (`maxOutputTokens`), and the price
version of the most expensive route the policy permits. Its doc states the
failure mode it exists to prevent: *"Sizing a hold from a typical response rather
than the worst allowed one is how a balance goes negative on a long generation."*

**Alia today.** Alia reserves **one credit**, always.
`CREDITS_CONFIG.INITIAL_RESERVATION = 1` (`credits-manager.ts:43`), and
`request-context.ts:185` calls `reserveCredits(req.user!.id)` with no amount, so
the default applies to every chat request regardless of prompt size, model
multiplier or `max_tokens`. The real cost is computed **after** the fact
(`finalizeCredits`, `credits-manager.ts:183-200`) and charged retroactively at
`_adjustReservation` (`:145-159`).

When the balance cannot cover the retroactive charge, `spendCreditsFreeFirst`
returns null and Alia calls `zeroCredits` (`credits-manager.ts:153`), logging
`'Insufficient credits for additional chat charge, set to 0'`. **Alia absorbs the
overspend.** That is the same failure the contract's hold prevents, expressed as
a floor at zero instead of a negative balance — so it is invisible in the ledger
and visible only as revenue that was never collected.

**Edit.** Not a port. The hold must be sized before the call, from the same three
inputs, which requires a price ceiling Alia does not have. Sequenced behind #972
workstream 7. What Alia can do *now*, independently of the contract, is size
`INITIAL_RESERVATION` from the request's own estimated prompt tokens and
`max_tokens` — the inputs are all present at `request-context.ts:186`. Raised as
an open question rather than done here, because changing what a user is charged
is a product decision, not a refactor.

### 4.4 Propagate `AbortSignal` and client disconnects

**Contract.** `errors.ts:57` has a `cancelled` code and `streamEvents.ts:201` a
`cancelled` finish reason; `usage.ts:135-140` reports a `cancelled` outcome. So
the contract expects cancellation to be a real, reported state.

**Alia today.** The abort signal exists but has exactly one trigger.
`baseConfig.abortSignal = providerAbort.signal` (`model-config.ts:124`) is fired
only by the 20-second first-byte timer (`:118-123`). A client disconnect does
**not** abort: `req.on('close')` sets a boolean (`provider-loop.ts:218-219`) and
that is its only effect — it appears exactly once in `packages/api/src/lib` and
`packages/api/src/routes` combined.

This is deliberate. The generation runs to completion, is saved, and is delivered
by push notification (`provider-loop.ts:343-345` → `notifyDisconnectedClient`).

**Edit.** Keep the behaviour and make it explicit: `AliaDisconnectPolicy` (§5)
carries `'finish_and_notify'` for chat and `'abort'` for everything else. Without
naming it, the obvious cutover — "wire `req.on('close')` to the abort signal" —
silently deletes a shipped feature. Note the cost the contract makes visible: a
finished-but-unread generation is fully metered and fully billed.

### 4.5 Circuit behaviour for Kaana unavailability at the product boundary

**Contract.** `errors.ts:59-63` supplies the codes (`deployment_unavailable`,
`service_unavailable`, …) but no circuit shape — breaking is the consumer's.

**Alia today.** Alia has a circuit breaker, and it is on the wrong side of the
line: `internal/providers/lib/provider-health.ts:179-206` opens per
`(provider, modelId)` with a cooldown. It breaks against *providers*, inside the
subsystem being removed. There is **no** breaker between Alia and any upstream
inference service, because there is no upstream inference service.

**Edit.** New code. The per-provider breaker is deleted with the provider tree
(workstream 7); a Kaana-level breaker is built fresh at the seam.

### 4.6 User-facing degradation when inference is unavailable

**Alia today.** Fully built, and better than the contract needs: three distinct
behaviours already exist, and they are the reason `AliaDegradation` is on the seam
rather than being invented later.

- The synthetic reply — `chat-completions.ts:276-304` — a friendly message in
  English or Spanish, `alia_meta: { synthetic: true, retryable: true }`, so a
  client never sees a raw failure. The reservation is refunded first
  (`:281-284`).
- Mid-stream graceful recovery — `stream-runner.ts:358-366` and
  `chat-completions.ts:325-331`.
- The 80-second timeout's own synthetic reply — `chat-completions.ts:48-62`.

**Edit.** None to the behaviour. It moves above the seam and is selected per
surface: only `visibility: 'user_turn'` earns a synthetic reply.

### 4.7 Do not fall back to direct provider imports under any configuration

**Alia today.** This is the whole of `gateway-client.ts`. Six functions carry a
`GATEWAY_API_ENABLED` branch whose else-arm is `await import('../internal/providers/…')`:
`resolveAliaModel` (`:339`), `callProviderAPI` (`:383`), `reportModelUsage`
(`:439-440`), `getAllAliaModels` (`:469`), `getAllProviderHealth` (`:612`),
`markKeyCreditExhausted` (`:718`). In production the else-arm is the *only* arm.

**Edit.** Delete the branch and the else-arm together. Until the Kaana client can
serve the request the else-arm is load-bearing, so this is the **last** edit of
the workstream, not the first.

---

## 5. Package boundaries, and the Alia-side seam

Three of this section's four checkboxes are about what Alia's product code may
import; the fourth is already enforced.

- *"Add architecture tests that fail when a direct provider module is imported
  from product code"* — **already done**, on `main`, by gate 1 of
  `packages/api/src/__tests__/architectureGates.test.ts:225` onward. It freezes
  every (importer, imported) pair crossing into `internal/providers/` and fails
  on a new one. Not this PR's work; recorded so nobody builds it twice.
- *"Shared stream/request types come from the contracts package, not local
  copies"* — enforced from today by
  `packages/api/src/lib/inference/__tests__/product-seam.test.ts`, which fails if
  any payload position in the seam is replaced by a declared shape.
- The remaining two need the published package.

### The seam

`packages/api/src/lib/inference/product-seam.ts` — unwired, on purpose.

It declares what the wire contract cannot: the conversation-level facts that are
decisions about an Alia product surface rather than about an inference call.
Every payload position is an unbound type parameter named for the contract symbol
that binds it.

| the seam declares | why the contract cannot |
| --- | --- |
| `ALIA_INFERENCE_SURFACES` | the cost centres of workstream 2; Alia's own product taxonomy |
| `AliaBillingMode` | whether the **end user's Alia credits** are charged — the contract's billing principal is the same Oxy account for every Alia call |
| `AliaCallVisibility` | whether a human is waiting; decides saving, charging and degradation |
| `AliaModelChoice` | the product's question, before it becomes a `RoutingTarget` |
| `AliaInferenceBudget` | §4.1 — the contract has no timeout shape |
| `AliaDisconnectPolicy` | §4.4 — "finish and notify" is a product decision |
| `AliaDegradation` | §4.6 — a policy about a surface, not a fact about an error |

**Two operations, and that shape is measured rather than chosen.** Across the 32
non-test modules importing `chat-core.ts`: 21 call `generateText`, 3 call
`streamText`, 2 call `generateObject`, and 6 make no inference call at all
(catalogue or type-only). Structured output is not a third operation — it is a
`responseFormat` on the same request (`request.ts:204-215`), so the seam follows
the contract rather than inventing a parallel spelling.

**Deliberately excluded:** the catalogue (workstream 5), provider health and key
accounting (Kaana), and any wiring. A half-wired seam is worse than an unwired
one, because it makes the cutover look done.

### 5.1 `reportModelUsage` has no destination

Six modules call it (`provider-loop.ts:358`, `stream-runner.ts:304`,
`agent/runner.ts`, `routes/webhooks.ts`, `routes/agents-avatar.ts`,
`routes/internal.ts`). It reports provider success/failure to Alia's own key
rotation and circuit breaker (`gateway-client.ts:416-453`).

Under the contract this direction **does not exist**: usage flows data-plane →
control-plane (`usage.ts:154-191`), never consumer → data-plane, and provider
health is not a thing a consumer observes. `reportModelUsage` is therefore
**deleted at cutover, not ported**, along with its six call sites. It is on no
seam by design.

---

## 6. What Alia does that the contract has no place for

Where behaviour gets silently dropped at cutover.

1. **Ten named SSE extension events.** `lib/chat-events.ts:3-12` declares nine names
   (`alia.plan_preview`, `alia.approval_request`, `alia.approval_result`,
   `alia.research_progress`, `alia.agent_session`, `alia.reasoning`,
   `alia.tool_result`, `alia.title`, `alia.model_switch`) and `alia.agent` is
   emitted at `stream-runner.ts:258` without being declared there. All ten have
   emission sites. The contract's stream union has seven event types and **no
   extension point** — `streamEvents.ts:228-236` is a closed discriminated union
   whose stated purpose is that an unknown event fails the parse. So these ten
   cannot ride the contract stream; Alia's SSE layer must emit them **above** the
   seam, interleaved with translated contract events. Consumers already depend on
   them: `packages/alia-chat/src/hooks/useAliaChat.ts:314` and
   `packages/app/lib/hooks/use-streaming-chat.ts:523,583`.
2. **The `alia_usage` block** on the terminal chunk (`provider-loop.ts:312-318`)
   — credits charged, credits remaining, credit warning. Product entitlement, not
   money; no contract counterpart and it should not get one.
3. **Alia's own credit ledger.** Reserve/finalize/refund
   (`credits-manager.ts:88`, `:183`, `:220`) is a second, independent
   reserve-settle-refund protocol operating on integer credits over Alia's users.
   It coexists with the contract's, at a different granularity, against a
   different principal. Workstream 12 owns the separation.
4. **Finish-and-notify on disconnect** — §4.4.
5. **The synthetic reply** — §4.6. The contract has no representation for "the
   request failed and the customer was told a friendly story instead", and
   correctly so; it is a product surface decision.
6. **`switchModel` as a tool.** The model can change the conversation's model
   mid-turn (`lib/tools/switch-model.ts`). The contract has no in-request
   mechanism for this and does not need one — it is Alia choosing a different
   `target` for the *next* request. But see the trap in §3.10.
7. **The tool-execution loop.** `stopWhen: stepCountIs(5)`
   (`model-config.ts:66`) and `MAX_TOOL_CALLS = 15` (`stream-runner.ts:65`) bound
   an agentic loop in which Alia executes tools locally and continues. The
   contract carries tool *definitions* and streams tool *calls*; it has no
   multi-step concept, so **each step is a separate contract request** with its
   own attribution, usage and receipt. A five-step turn is five requests. This
   changes what "one request" means for metering and is the most likely source of
   a surprising bill after cutover.

---

## 7. Open questions

Each needs a decision from a named owner before the post-publish PR can be
written. None is answerable from either repository today.

| # | question | owner |
| --- | --- | --- |
| 1 | A request whose `target` is a `routing_profile` has no `requestedModelId`, so `inferenceRouteSwitchDetailSchema`'s `scope: 'model'` branch (`streamEvents.ts:132-149`) cannot be constructed for it. Is a profile-targeted request resolved once and then subject to `deployment` switches only, or is the union missing a third scope? Alia's `alia-*` aliases become profiles in workstream 4, so this decides whether Alia can report a switch at all. | Oxy contract owner |
| 2 | Sizing the reservation from the request rather than the flat 1 credit (§4.3) changes what users are charged on large prompts. Ship it before Kaana, or wait? | #139 epic owner |
| 3 | Does Alia adopt the contract's `usageSource` distinction now? Today a provider that reports no usage is indistinguishable from zero usage (`model-config.ts:71` coalesces to 0, `credits-manager.ts:69-70` then charges the 1-credit minimum) — an estimate presented as a measurement. | #139 epic owner |
| ~~4~~ | **Answered by #139 workstream 20.** Fixed in the sanitiser: concealment now matches identifiers and proper nouns, so `llama` in Spanish prose survives. `sanitize.test.ts` walks the shipped `es.json` and fails on any string the sanitiser rewrites. | closed |
| 5 | Interim exposure on `POST /v1/chat/completions` (OxyHQ/oxy#981) — options 1, 2 or 3 in that issue. Alia is the billed party, so Alia has an interest in the answer. | Oxy API owner |

## 8. Reopening conditions

- **§0 expires** the moment a version above `0.26.0` of `@oxyhq/contracts`
  publishes with `dist/types/index.d.ts` naming `inferenceRequestSchema`. Re-run
  the two measurements in §0 with their positive controls before acting on this
  document.
- **§1 expires** if `packages/api/src/routes/` in OxyHQ/oxy gains a file matching
  `inference` or `kaana`, or if `server.ts` mounts one. The check is one
  `git ls-tree`.
- **§3 and §4 are dated 2026-08-16** against Alia `main` at `bd7d281e`. Every
  `path:line` should be re-derived, not trusted, if `lib/chat/` has moved since.
