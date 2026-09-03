# Alia API reference

Base URL: `https://api.alia.onl`

This page is organised around the boundary
[ADR 0004](./adr/0004-product-endpoints-versus-generic-inference-endpoints.md) draws, not
around HTTP shape, because the same handler serves two audiences and the difference is
what a reader needs first:

- **[The Alia product runtime](#the-alia-product-runtime)** — everything the app, Codea,
  Cowork, the CLI and the SDK call. Alia owns it and keeps owning it.
- **[The bounded compatibility surface](#the-bounded-compatibility-surface-v1)** —
  `api.alia.onl/v1/*`. Presented as a generic OpenAI-compatible API, inside a compatibility
  window, then removed. New generic integrations go to Oxy Console and `api.oxy.so/v1`.
- **[Already removed](#already-removed-410-gone)** — four endpoints returning `410 Gone`.

Routes are mounted in `packages/api/src/index.ts:221` through `:257`.

## Authentication

| Credential | Where it works |
|---|---|
| `Authorization: Bearer <session-token>` | Everywhere. Issued by Oxy, verified by `packages/api/src/middleware/auth.ts` |
| `Authorization: Bearer alia_sk_<key>` | `/v1/*` and `/codea/*` only. Inside the compatibility window — see [developer access](./developers-portal.md) |
| Oxy service token | `POST /internal/trigger` only, via `oxyServiceAuth` |
| `x-channel-bot-secret` + `x-oxy-user-id` | Registered channel bots. Validated by `authenticateChannelBotSecret` (`packages/api/src/middleware/auth.ts`), which `authenticateTokenOrApiKey` dispatches to — so it works on `/alia/chat` as well as `/v1/*`. `routes/v1.ts:35` holds a second, pre-auth copy that matches against `listChannels()` rather than `getConfiguredChannels()` |

`POST /alia/chat` and `/v1/*` are both mounted with `authenticateTokenOrApiKey`
(`packages/api/src/routes/chat.ts`, `routes/v1.ts:59`) plus the same per-key rate limit
(`:62`). `POST /alia/chat` carried `optionalAuth` until #139 workstream 6, which meant an
unauthenticated caller reached the same inference handler with no credit reservation while
`/v1/chat/completions` refused the identical request with 401; the two surfaces now share
one session model. `GET /alia/chat` is a status banner and stays public.

---

## The Alia product runtime

Alia owns conversations, memory and the context graph, agents, tools and
tool execution, approvals and the R0–R3 risk policy, deep research, triggers,
notifications, Codea and Cowork behaviour, and product entitlements. None of it moves to
Kaana.

### Chat

**`POST /alia/chat`** — the product runtime. Same handler as `/v1/chat/completions`
(`packages/api/src/routes/chat.ts` dispatches to `handleChatCompletions`) and, since #139
workstream 6, the same authentication. Every remaining difference between the two surfaces
is enumerated in `packages/api/src/routes/__tests__/v1-compatibility-surface.test.ts`.

Minimal request:

```json
{
  "model": "profile:v1",
  "messages": [{ "role": "user", "content": "Prepare my meeting with Sarah" }],
  "stream": true
}
```

Product extras: `conversationId`, `thinkingMode`, `agentMode`, `deepResearch`, `tools`,
`stream_options.include_usage`.

**`GET /alia/chat`** returns a service status object, not a completion.

The SSE contract, with each event's emitting line and exact payload fields, is in
[the chat runtime page](./chat-runtime.mdx). Two corrections worth carrying here, because
earlier revisions of this page had both wrong:

- `alia.plan_preview` carries `eventVersion`, `planId` and `steps`. It does **not** carry
  `intent` or `confidence`.
- `alia.approval_request` and `alia.approval_result` are **Socket.IO** events
  (`packages/api/src/socket.ts:216`, `:231`), not SSE events. Nothing writes them to the
  HTTP stream.

### Conversations, memory and context

| Mount | Owner module |
|---|---|
| `/conversations` | `routes/conversations.ts` |
| `/memory` | `routes/memory.ts` |
| `/library` | `routes/library.ts` |
| `/writing-style` | `routes/writing-style.ts` |
| `/suggestions` | `routes/suggestions.ts` |

### Agents and execution

| Mount | Owner module |
|---|---|
| `/agents` | `routes/agents.ts` |
| `/skills` | `routes/skills.ts` |
| `/containers` | `routes/containers.ts` |
| `/tools` | `routes/tools-proxy.ts`, proxied to the integrations service |
| `/mcp` | `routes/mcp.ts` |

### Triggers and structured automations

`/triggers` remains the transitional API for legacy routines. `/automations` is the
normalized control plane for explicit actors, resources, actions, data flow and autonomy.
Both scheduled row types are reconciled by the same elected scheduler.

| Route | Purpose |
|---|---|
| `GET /triggers` | List the caller's triggers |
| `POST /triggers` | Create one. Required: `name`, `type` (`schedule \| webhook \| integration_event`), `action.prompt` |
| `PATCH /triggers/:id` | Update |
| `DELETE /triggers/:id` | Delete |
| `POST /triggers/:id/run` | Manual run |
| `GET /triggers/:id/executions` | Execution history |
| `POST /triggers/webhook/:token` | Run a webhook trigger by token |
| `GET /automations` | List structured definitions |
| `POST /automations` | Create an observe/execute definition and receipt |
| `PATCH /automations/:id` | Edit objective, trigger, actor assignment, resources, data flow, autonomy, limits, or enabled state; execution authority is revalidated |
| `DELETE /automations/:id` | Stop and revoke its execution authorizations |
| `POST /automations/:id/run` | Run a manual definition with an `Idempotency-Key` |
| `GET /automations/runs` | List decision and execution history |
| `GET /automations/runs/:runId/steps` | List correlated steps for an owned run |

### Webhooks and events

**`POST /webhooks/oxy`** — normalized Oxy application events
(`routes/oxy-service-events.ts`). The publisher authenticates with an Oxy service bearer,
must own the signed capability catalog for the declared app and may publish only event
types in that catalog. The route enforces app/account/resource consistency, claims each
`(appId, eventId)` once and dispatches matching structured automations. The former
per-service HMAC route, `POST /webhooks/oxy/:serviceId`, returns `410 Gone`.

**`/webhooks`** — channel bot inbound (`routes/webhooks.ts`) plus the CrowdSource webhook
routes mounted at `packages/api/src/index.ts:194`.

**`POST /internal/trigger`** — autonomous processing for internal Oxy services
(`routes/internal.ts:123`). Oxy service tokens only, user delegation via the
`X-Oxy-User-Id` header, no credits charged.

### Notifications

| Route | Purpose |
|---|---|
| `GET /notifications` | Paginated list. `status` (`pending \| sent \| read \| dismissed`), `type`, `limit` (default 30, max 100), `offset` |
| `GET /notifications/unread-count` | `{ count: number }` |
| `PATCH /notifications/:id/read` | Mark one read |
| `POST /notifications/read-all` | Mark all read |
| `PATCH /notifications/:id/dismiss` | Dismiss one |
| `POST /notifications/push-token` | Register an Expo push token. Body `{ token, platform?, deviceId? }` |
| `DELETE /notifications/push-token` | Deactivate one. Body `{ token }` |
| `GET /notifications/vapid-public-key` | VAPID public key. **No auth required** |
| `POST /notifications/web-push-subscription` | Register a browser subscription. Body `{ endpoint, keys: { p256dh, auth } }` |
| `DELETE /notifications/web-push-subscription` | Deactivate one. Body `{ endpoint }` |

**Socket.IO.** Connect at the API origin, emit `subscribe-notifications` with the user id,
and listen for `notification`, `alia.approval_request` and `alia.approval_result`. The same
channel emits cache-invalidation events for conversation, trigger and notification lists.

### Codea

| Route | Purpose |
|---|---|
| `GET /codea/user` | Entitlement payload |
| `GET /codea/token` | Token and quota metadata |
| `GET /codea/mcp_registry` | MCP policy metadata |
| `GET /codea/me` | Current user summary |

### Catalogue and analytics

| Route | Purpose |
|---|---|
| `GET /catalogue` | The truthful catalogue: routing profiles keyed `profile:*` and individually selectable models keyed `<publisher>/<model>`, each carrying its real kind (`routes/catalogue.ts`) |
| `GET /catalogue/modes` | The product modes a person picks between (`routes/catalogue.ts`) |
| `GET /models/stats`, `GET /models/stats/:modelId` | Product usage statistics per Alia identifier (`routes/models-stats.ts`) |
| `GET /external-models`, `/external-models/organizations`, `/external-models/:modelId` | The external-model leaderboard (`routes/external-models.ts`) |
| `/analytics` | Product analytics |
| `/audit`, `/reports` | Audit trail and user reports |

The external-model leaderboard is inventoried separately under workstream 10 of #139; its
destination is not decided by this page.

### Health

| Route | What it answers |
|---|---|
| `GET /health/live` | "Is this process running." Deliberately unconditional — it consults no dependency |
| `GET /health/ready` | "Can this task serve traffic." Issues a real `select 1` against Postgres (`routes/health.ts:59`) |
| `GET /health` | Detailed snapshot, cached for 10 seconds |

MongoDB is not reported by any of the three, and there is nothing for them to report:
`packages/api` registers no Mongoose model and opens no connection. Postgres is the only
dependency a readiness answer turns on.

### Moving to Oxy

Two mounts are in the product runtime today and are Oxy's under the ADRs:

- **`/developer`** — applications and `alia_sk_*` credentials. ADR 0001 and ADR 0004 assign
  developer identity to Oxy. Creation is already closed: `POST /developer/apps`,
  `POST /developer/apps/:appId/keys` and the three `/auth` routes that were the second
  minting path (`/authorize/codea`, `/authorize/cowork`, `/token`) all answer `410 Gone`
  with `"error": "issuance_closed"`. Reading, updating and revoking an existing credential
  stay. See [developer access](./developers-portal.md) for the routes, what still works,
  and the removal gate. Workstream 11 of #139.
- **`/billing`** — Stripe checkout, subscriptions and the financial record. ADR 0005 keeps
  entitlements in Alia as a low-latency read model and moves balances, payments, invoices,
  transactions and the ledger to Oxy. `/credits` stays as an entitlement read.
  Workstream 12 of #139.

---

## The bounded compatibility surface (`/v1/*`)

ADR 0004 records the decision: `api.alia.onl/v1/*` remains available for a **bounded**
window, authenticating through Oxy, issuing no new Alia credentials, settling no provider
billing in Alia — and then sunsets. Of the three options in workstream 6 of #139 (redirect
or proxy, bounded compatibility endpoint, immediate removal) this is the middle one, with
the sunset attached.

Routes mounted in `packages/api/src/routes/v1.ts`:

| Route | Mount | Auth |
|---|---|---|
| `GET /v1/` | `:20` | none |
| `GET /v1/models`, `GET /v1/models/:modelId` | `:28` | none — mounted ahead of the auth middleware |
| `GET /v1/me` | `:68` | session or key |
| `POST /v1/chat/completions` | `:127` | session or key |
| `/v1/responses` | `:130` | session or key |
| `/v1/voice` | `:133` | session or key |
| `/v1/audio` | `:136` | session or key |
| `/v1/images` | `:139` | session or key |

**What still works.** These routes are served with their existing request and response
shapes. Product `alia.*` SSE events may still appear on them, because this surface is the
product runtime under an older name.

**What does not.** The surface gains no new route, no new capability and no new model.

**Removal gate, per route.** A measurement over `api_key_usage` filtered to that
`endpoint`, across a window shorter than the 90-day retention and covering at least one
full monthly billing cycle, showing zero external requests — with a positive control on a
route known to be live over the same window. *Or* an enumeration showing every known
consumer has migrated. Plus a documented replacement: either the equivalent
`api.oxy.so/v1` route is live, or the capability is explicitly recorded as not carried
forward. Route-by-route is deliberate, because gating the whole surface on its
least-migrated route keeps the rest alive for no reason.

**Deprecation signal.** `Deprecation` and `Sunset` headers with a `Link` to the migration
documentation, plus `alia.deprecation` on streaming responses — for **this surface**, none
of the three is emitted, and emitting them is a prerequisite for starting this clock.

The alias deprecation of path (a) is a different subject that happens to be visible here:
its middleware is mounted app-wide, so a `/v1/*` request naming one of the thirteen
`alia-*` identifiers already carries `Deprecation` and `Link`, and a streaming one carries
`alia.deprecation`. That says the alias is deprecated, not the surface. Whether the surface
signal is per-route or blanket across `/v1/*` is an open question owned by workstream 6.

The clock owner is the owner of workstream 6, recorded on the epic.

### `GET /v1/models`

```json
{ "object": "list", "data": [] }
```

**Empty, and that is the honest answer.** It listed thirteen `alia-*` identifiers as
`object: 'model'`, and every one of them is a routing profile rather than a model —
`docs/migration/alias-migration-map.json` records the fan-out measurement. Alia publishes no
models, the `alia/*` publisher namespace is reserved and empty, so there is nothing for an
OpenAI-shaped model list to name.

Read [`GET /catalogue`](#catalogue-and-analytics) for the routing profiles and the models,
and `GET /catalogue/modes` for the product modes a person picks between.

**Requests are unaffected.** The aliases still resolve; they are advertised by nothing.
Every installed `@alia.onl/sdk` and `@alia-codea/cli` copy keeps working.
`docs/migration/compatibility-window.md` records that closure, its date and its evidence.

`GET /v1/models/:modelId` answers `410` for a retired alias, naming the routing profile it
became, and `404` for anything else — a bare 404 for an identifier that worked last week is
indistinguishable from a typo or an outage.

### `GET /catalogue`

Two kinds of entry, and a client switches on `object` rather than on a naming convention.

**Routing profiles**, keyed by `profile:*` — the same identifier the migration map publishes
as each alias's replacement. One per profile, `object: "routing_profile"`, carrying
`selects_among`: how many distinct models the policy ranks over.

**Models**, keyed by `<publisher>/<model>` — `object: "model"`, with `publisher` and `model`
as separate fields. Sending one as `model` on a chat request is answered by that model, on
whichever deployment serves it; a request that names a profile is answered by whichever
model the profile picks.

Both are what they say they are: an entry resolving to one model identity is a `model`, one
selecting among several is a `routing_profile`, and the kind is derived from the routing
table on every request rather than declared.

Not every model in the routing table is individually selectable. A model is offered on its
own only when its price sits inside the band its routing profile is already sold at —
Alia bills one credit multiplier per profile, so a model that costs more per token than the
profile's own default cannot be pinned without the multiplier becoming a lie
(`packages/api/src/lib/routing/model-selection.ts`). A model outside that band is still
reachable through the profiles that route to it; naming it directly answers `400` with
`unknown_model`. `pricing.credit_multiplier` on a model entry is the profile's, which is
what a request on that model is billed at.

`publisher` names who RELEASED the model and never who serves it. Which operator answers a
request is a property of the deployment and appears nowhere in this response. No `alia-*`
identifier appears anywhere in it either.

**`availability.status` means a route could actually serve you.** An entry is `available`
when at least one route behind it is on a provider holding a usable credential AND has an
unbroken circuit; otherwise it is `unavailable`, and choosing it answers with a refusal
rather than a slow reply. Both halves are load-bearing and the first is the one clients
should not try to infer: a circuit breaker records what happened to traffic and cannot
record traffic that never left, so a deployment with no provider credential at all reports
every breaker closed. A catalogue that could not be computed is a `500`, never a catalogue
in which nothing is available — "we could not find out" and "nothing works" are different
answers.

### `GET /catalogue/modes`

The product modes a person picks between. Product configuration, not models: no publisher,
no revision, no model card, and never `object: 'model'`.

```json
{
  "object": "list",
  "data": [
    { "id": "mode:automatic", "object": "product_mode", "label": "Automatic",
      "description": "Alia picks how to answer.",
      "routing": { "kind": "default" }, "deep_research": false },
    { "id": "mode:balanced", "object": "product_mode", "label": "Balanced",
      "description": "The everyday default: quick enough, capable enough.",
      "routing": { "kind": "profile", "profile_id": "profile:v1" }, "deep_research": false }
  ]
}
```

`routing.kind` is `profile` when the mode pins one, and `default` when it pins none —
`Automatic` and `Deep research` both change nothing about routing today, and publishing a
`profile_id` for them would be a routing claim the product does not make. Unauthenticated
and unfiltered: a mode is the same for everybody, and what a given caller may use is
entitlement, annotated per entry on `GET /catalogue`.

---

## Already removed (`410 Gone`)

Four endpoints answer `410` with a message naming the replacement. There is no
compatibility shim, and this is the pattern compatibility-window removals will follow
rather than deleting a route and returning a bare `404`.

| Endpoint | Handler | Message |
|---|---|---|
| `POST /v1/resolve-model` | `routes/v1.ts:109` | "Use /v1/chat/completions with Alia model IDs. Direct model resolution is internal-only." |
| `POST /v1/report-usage` | `routes/v1.ts:120` | "Usage is tracked automatically by Alia runtime." |
| `POST /codea/resolve-model` | `routes/codea.ts:235` | Same as `/v1/resolve-model` |
| `POST /codea/report-usage` | `routes/codea.ts:246` | Same as `/v1/report-usage` |

The two `/codea` routes still run `authenticateApiKey` and the per-key rate limit before
answering `410`, so an unauthenticated caller gets a `401` rather than the `410`.

---

## Error contract

- User-facing errors pass through `sanitizeMessage()`
  (`packages/api/src/lib/errors/sanitize.ts`). It applies two rules. The first is
  absolute and holds on every surface: no credential, no internal endpoint, and no raw
  upstream error body — which includes the upstream error-code vocabulary
  (`overloaded_error` names one operator as surely as the word does). The second conceals upstream operator names and model ids, and is
  scoped to the product surface.
- The concealment half is a product decision and best-effort by construction: it matches
  identifiers — a proper noun, or a `/ . - _ =` joined token — and leaves ordinary prose
  alone. It is not a security control, and nothing should be designed as if it were.
- A value the CALLER sent is echoed back readable. `"gpt-4o" is not an Alia model`
  discloses nothing about Alia's routing, so it takes `redactUnsafeDetail()` — the
  absolute half alone.
- Product responses carry Alia identifiers only. See
  [model abstraction](./model-abstraction.mdx) for the surfaces the second rule covers,
  and the ones where publisher identity is required instead.

## Open questions

- **Whether `Deprecation` and `Sunset` are emitted per-route or blanket across `/v1/*`.**
  Per-route measurement is decided; per-route headers are not. *Owner: workstream 6 owner.*
- ~~**Whether `/v1/shows` belongs to the compatibility window at all.**~~ ANSWERED, in
  #327: it does not. The workstream 1 inventory had already assigned all five routes
  `"proposedOwner": "alia"` and `"targetPath": "keep-alia-product"`, so they moved to
  `/shows` beside `/conversations`, `/skills` and `/agents`. This surface is fifteen
  routes, and it lost five without gaining any.
