# Alia API reference

Base URL: `https://api.alia.onl`

This is the HTTP surface of **Alia's product API** — permanent under
[ADR 0010](./adr/0010-alia-keeps-a-product-api-credentials-come-from-oxy-console.md),
which amends the sunset [ADR 0004](./adr/0004-product-endpoints-versus-generic-inference-endpoints.md)
§3 had attached to `/v1/*`. It is not a generic inference API: for raw model access use
Kaana through Oxy (`api.oxy.so/v1`); for the assistant — conversations, memory, agents,
tools, research and the `alia.*` stream events — use this one. Keys for either come from
Oxy Console. The page is organised by mount, because one handler sits behind two:

- **[The Alia product runtime](#the-alia-product-runtime)** — everything the app, Codea,
  Cowork and the CLI call. Alia owns it and keeps owning it. `@alia.onl/sdk` is written
  against it too, but its transport still enters through `/v1/chat/completions`, for the
  CORS reason under [Chat](#chat).
- **[The `/v1/*` mount](#the-bounded-compatibility-surface-v1)** — `api.alia.onl/v1/*`,
  the OpenAI-shaped entry to the same runtime, with public CORS. The section below still
  carries ADR 0004's window text and is read with ADR 0010's amendment: the routes are
  frozen at their current list, not removed.
- **[Already removed](#already-removed-410-gone)** — two endpoints returning `410 Gone`, and the routes deleted outright by the clean cut.

Routes are mounted in `packages/api/src/index.ts:221` through `:257`.

## Authentication

| Credential | Where it works |
|---|---|
| `Authorization: Bearer <session-token>` | Everywhere. Issued by Oxy, verified by `packages/api/src/middleware/auth.ts` |
| `Authorization: Bearer alia_sk_<key>` | **Nowhere.** Retired: refused `401 credential_retired` — see [developer access](./developers-portal.md) |
| Oxy Console application key (`oxy_sk_*`) | **Not yet.** It is not a JWT, so `oxy.auth()` in `@oxy.so/core` refuses it `401 INVALID_TOKEN_FORMAT`; the lane is built in the Oxy API first (OxyHQ/oxy#972), then `@oxy.so/core/server`, then adopted here — ADR 0010 § 2 |
| Oxy service token | `/internal/trigger` via `oxyServiceAuth`; `/alia/chat` and `/v1/*` through `authenticateTokenOrApiKey` only when `X-Oxy-User-Id` names an exact grant-verified delegation; on the two chat surfaces also with an `X-Oxy-Requester-Assertion` that Oxy minted for the presenting product and consumes live (`authenticateRequesterAssertion`, OxyHQServices ADR 0025) — see [agents](./agents.md#product-bound-agents) |
| `x-channel-bot-secret` + `x-oxy-user-id` | Registered channel bots. Validated by `authenticateChannelBotSecret` (`packages/api/src/middleware/auth.ts`), which `authenticateTokenOrApiKey` dispatches to — so it works on `/alia/chat` as well as `/v1/*`. `routes/v1.ts:35` holds a second, pre-auth copy that matches against `listChannels()` rather than `getConfiguredChannels()` |

A delegated service request (`X-Oxy-User-Id`) is verified by Alia's OWN
credentialed Oxy client (`lib/oxy-service-client.ts`), not by the credential-free
`oxyClient` that verifies inbound user tokens: the SDK checks the acting-as grant
through a service-to-service endpoint and must present the verifier's own service
token to reach it. With no credential it threw, cached a negative answer and
refused every delegated user with `403 SERVICE_ACTING_AS_UNAUTHORIZED` — a valid
grant included. A deployment that somehow holds no identity now answers
`503 SERVICE_DELEGATION_UNAVAILABLE` instead of blaming the caller's grant;
being able to mint an Oxy service token — from a credential pair, or by
attesting the ECS task role under oxy ADR 0026 — is a boot requirement, so a
serving process always can.

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
  "model": "acme/chat-large",
  "messages": [{ "role": "user", "content": "Prepare my meeting with Sarah" }],
  "stream": true
}
```

`model` is a `<publisher>/<model>` from [`GET /catalogue`](#get-catalogue), a
`local/<runtime>/<model>` served by the caller's own device, or absent for the person's
default model. Any other value — including the retired `mode:*` and `route:*`
spellings — is refused `400` with `code: "model_not_found"` and `param: "model"`.

Product extras: `conversationId`, `reasoningEffort` (`low` | `medium` | `high`, accepted
only when the model lists that level in `reasoningEfforts`, else `400`
`invalid_reasoning_effort`; forwarded to Oxy as `reasoning: { effort }`), `surface`
(`chat` | `codea` | `cowork`, default `chat` — selects the system prompt, never the
model), `responseMode: "voice"`, `agentMode`, `deepResearch`, `tools`,
`stream_options.include_usage`.

**`GET /alia/chat`** returns a service status object, not a completion.

**Browser origins.** `/alia/chat` takes the internal CORS policy — the exact-origin
allowlist in `packages/api/src/lib/cors-origins.ts` plus `WEB_URL`, mounted in
`packages/api/src/index.ts` for every path that is not `/v1` — so a preflight from
`https://alia.onl` or `https://console.alia.onl` is answered with that origin and
credentials, one from a loopback dev origin the same, and one from any other origin gets
no `access-control-allow-origin` at all. `/v1/*` answers `*` instead. A request with no
`Origin` header — a server, a native app, `curl` — is never subject to either. The policy
is pinned by `packages/api/src/middleware/__tests__/chat-origin-policy.test.ts`, and it is
why `@alia.onl/sdk`, a product client that compiles into apps on origins Alia does not
enumerate, still defaults to `/v1/chat/completions`. **An external product using the SDK
goes through its own backend**: `useAliaChat({ apiUrl })` at the consumer's backend, which
calls `POST /alia/chat` server-to-server with the user's Oxy token forwarded and streams
the SSE body back unchanged — `packages/alia-chat/README.md` has the relay, and #244 the
two other shapes and why neither is available yet.

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
| `/tools` | `routes/tools-proxy.ts`, proxied to the integrations service |
| `/mcp` | `routes/mcp.ts` |

### Structured automations

`/automations` is the only control plane for proactive work. It stores explicit actors,
resources, actions, data flow and autonomy, and is the only source read by the elected
scheduler. The legacy `/triggers` routes were deleted with their tables.

| Route | Purpose |
|---|---|
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
channel emits cache-invalidation events for conversation and notification lists.

### Catalogue and analytics

| Route | Purpose |
|---|---|
| `GET /catalogue` | The models a chat can use, from Oxy's catalogue, with the caller's default and the featured ids (`routes/catalogue.ts`) |
| `/analytics` | Product analytics |
| `/audit`, `/reports` | Audit trail and user reports |

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

One mount is in the product runtime today and is Oxy's under the ADRs (the other,
`/developer`, was deleted with the `alia_sk_*` keys — see
[developer access](./developers-portal.md)):

- **`/billing`** — Stripe checkout, subscriptions and the financial record. ADR 0005 keeps
  entitlements in Alia as a low-latency read model and moves balances, payments, invoices,
  transactions and the ledger to Oxy. `/credits` stays as an entitlement read.
  Workstream 12 of #139.

---

## The product API under its OpenAI-compatible shape (`/v1/*`)

[ADR 0010](./adr/0010-alia-keeps-a-product-api-credentials-come-from-oxy-console.md)
records the decision: `api.alia.onl/v1/*` is Alia's **permanent** product API under an
OpenAI-compatible request shape — the same handler as `/alia/chat` — authenticating
through Oxy, issuing no Alia credentials of its own and settling no provider billing in
Alia. It does not sunset; what retired is the `alia_sk_*` credential path, which is gone.
ADR 0004 §3, which read this surface as a bounded compatibility window, is amended
by ADR 0010.

Routes mounted in `packages/api/src/routes/v1.ts`:

| Route | Mount | Auth |
|---|---|---|
| `GET /v1/` | `:20` | none |
| `GET /v1/models`, `GET /v1/models/:modelId` | `:28` | none — mounted ahead of the auth middleware |
| `GET /v1/me` | `:68` | Oxy session or service token |
| `POST /v1/chat/completions` | `:127` | Oxy session or service token |
| `/v1/responses` | `:130` | Oxy session or service token |
| `/v1/audio` | `:136` | Oxy session or service token |
| `/v1/images` | `:139` | Oxy session or service token |

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

The same list as [`GET /catalogue`](#get-catalogue), in the OpenAI shape:

```json
{
  "object": "list",
  "data": [
    { "id": "acme/chat-large", "object": "model", "created": 1754006400, "owned_by": "acme" }
  ]
}
```

`owned_by` is the publisher id. Alia publishes no models of its own; every entry is a real
model from Oxy's catalogue, and the `alia/*` publisher namespace stays reserved and empty
(ADR 0002).

### `GET /catalogue`

The models Alia's chat can use: Oxy's catalogue (`OxyInferenceClient.listModels()`),
cached for five minutes and filtered to text in, text out and tool calls supported.

```json
{
  "object": "list",
  "defaultModelId": "acme/chat-large",
  "featuredIds": ["acme/chat-large", "example/reasoner-2"],
  "data": [
    {
      "id": "acme/chat-large",
      "object": "model",
      "name": "Chat Large",
      "publisher": { "id": "acme", "name": "Acme" },
      "description": null,
      "contextWindow": 131072,
      "maxOutput": 16384,
      "inputModalities": ["text", "image"],
      "outputModalities": ["text"],
      "tools": true,
      "reasoningEfforts": ["low", "medium", "high"],
      "pricing": { "inputPerMTok": "0.15", "outputPerMTok": "0.60" },
      "releasedAt": "2026-08-01",
      "featured": true
    }
  ]
}
```

- `id` is what a chat request sends as `model`.
- `description`, `contextWindow`, `maxOutput`, `pricing` and `releasedAt` are `null` when
  the catalogue does not carry them. `pricing` is USD per million tokens, as decimal strings.
- `reasoningEfforts` lists the levels `reasoningEffort` may take for that model; `[]` means
  the model takes none.
- `defaultModelId` is the caller's default: the model they last used, else the most-used
  featured model, else the cheapest featured model. `featuredIds` is the newest model of
  each publisher, ranked by Alia's usage over the last 30 days, recomputed daily.
- Every plan can use every model; plans differ only in credits.

`publisher` names who released the model. The operator serving a deployment and deployment
ids appear nowhere in this response. `GET /catalogue/modes` no longer exists
([ADR 0012](./adr/0012-alia-uses-real-models.md)).

---

## Already removed (`410 Gone`)

Two endpoints answer `410` with a message naming the replacement. There is no
compatibility shim.

| Endpoint | Handler | Message |
|---|---|---|
| `POST /v1/resolve-model` | `routes/v1.ts:121` | The message names the replacement: `/v1/chat/completions`. |
| `POST /v1/report-usage` | `routes/v1.ts:120` | "Usage is tracked automatically by Alia runtime." |

**Deleted outright (`404`)** by the owner's clean cut, with no `410` stub: every
`/developer/*` route, every `/codea/*` route (including the two former `410`s), the
`/auth/authorize/codea`, `/auth/authorize/cowork` and `/auth/token` refusals, every
`/triggers/*` route, `GET /agents/:id/reports`, `GET /agents/:id/routing-logs`,
`GET /agents/:id/routing-stats`, `GET /external-models*` and
`GET`/`DELETE /api/sessions/:conversationId`.

The agent clean cut removed two more. `POST /agents/:id/hire` refused with `503`
for its whole life in production — it required a sandbox or a local browser, and
the runtime image has neither — and no client called it; an explicit goal,
`POST /agents/threads/:threadId/goals`, is the only paid hire. `GET /agents/health`
reported that same `shell: false, browser: false` and went with it.

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
- A value the CALLER sent is echoed back readable. `"acme/unknown" is not an available model`
  discloses nothing about Alia's routing, so it takes `redactUnsafeDetail()` — the
  absolute half alone.
- Product responses carry canonical `<publisher>/<model>` identifiers; model and publisher
  names are shown. See [models in Alia](./model-abstraction.mdx) for what stays concealed
  (the serving operator and deployment ids).

## Open questions

- **Whether `Deprecation` and `Sunset` are emitted per-route or blanket across `/v1/*`.**
  Per-route measurement is decided; per-route headers are not. *Owner: workstream 6 owner.*
- ~~**Whether `/v1/shows` belongs to the compatibility window at all.**~~ ANSWERED, in
  #327: it does not. The workstream 1 inventory had already assigned all five routes
  `"proposedOwner": "alia"` and `"targetPath": "keep-alia-product"`, so they moved to
  `/shows` beside `/conversations`, `/skills` and `/agents`. This surface is fifteen
  routes, and it lost five without gaining any.
