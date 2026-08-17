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
| `x-channel-bot-secret` + `x-oxy-user-id` | Registered channel bots, validated at `packages/api/src/routes/v1.ts:35` |

`/alia/chat` is mounted with `optionalAuth` (`packages/api/src/routes/chat.ts:8`); `/v1/*`
with `authenticateTokenOrApiKey` (`routes/v1.ts:59`) plus a per-key rate limit (`:62`).

---

## The Alia product runtime

Alia owns conversations, memory and the context graph, agents and agent teams, tools and
tool execution, approvals and the R0–R3 risk policy, deep research, triggers,
notifications, Codea and Cowork behaviour, and product entitlements. None of it moves to
Relay.

### Chat

**`POST /alia/chat`** — the product runtime. Same handler as `/v1/chat/completions`
(`packages/api/src/routes/chat.ts:8` dispatches to `handleChatCompletions`), different
auth.

Minimal request:

```json
{
  "model": "alia-v1",
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
| `/agents/avatar` | `routes/agents-avatar.ts` |
| `/agents/teams` | `routes/agent-teams.ts` |
| `/skills` | `routes/skills.ts` |
| `/containers` | `routes/containers.ts` |
| `/tools` | `routes/tools-proxy.ts`, proxied to the integrations service |
| `/mcp` | `routes/mcp.ts` |

### Triggers

`/triggers` is the only scheduling API. There is no second scheduler; all `/automations*`
endpoints were removed.

| Route | Purpose |
|---|---|
| `GET /triggers` | List the caller's triggers |
| `POST /triggers` | Create one. Required: `name`, `type` (`schedule \| webhook \| integration_event`), `action.prompt` |
| `PATCH /triggers/:id` | Update |
| `DELETE /triggers/:id` | Delete |
| `POST /triggers/:id/run` | Manual run |
| `GET /triggers/:id/executions` | Execution history |
| `POST /triggers/webhook/:token` | Run a webhook trigger by token |

### Webhooks and events

**`POST /webhooks/oxy/:serviceId`** — Oxy service events (`routes/oxy-service-events.ts`).
Idempotent by `eventId`, HMAC verified, creates a persistent `AgentSession` before
autonomous queueing, and falls back to a notification if autonomous execution fails.

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

MongoDB is not reported by any of the three. Mongoose call sites remain until the last
domain is ported, but their failure mode is a 500 on the route that made the call — the
connection uses `bufferCommands: false`, so those calls throw rather than hang.

### Moving to Oxy

Two mounts are in the product runtime today and are Oxy's under the ADRs:

- **`/developer`** — applications and `alia_sk_*` credentials. ADR 0001 and ADR 0004 assign
  developer identity to Oxy. See [developer access](./developers-portal.md) for the routes,
  what still works, and the removal gate. Workstream 11 of #139.
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
| `/v1/shows` | `:31` | `optionalAuth` |
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
documentation, plus `alia.deprecation` on streaming responses. None of the three exists in
the API today; emitting them is a prerequisite for starting the clock. Workstream 19 of
#139.

The clock owner is the owner of workstream 6, recorded on the epic.

### `GET /v1/models`

```json
{
  "object": "list",
  "data": [
    {
      "id": "alia-v1",
      "object": "model",
      "created": 1755000000,
      "owned_by": "alia",
      "name": "Alia V1",
      "category": "general",
      "is_default": true,
      "is_available": true,
      "required_plan": null,
      "capabilities": { "tools": true, "vision": true, "max_tokens": 8192 },
      "pricing": { "credit_multiplier": 1 }
    }
  ]
}
```

Query parameters: `category` (`general | coding | vision | audio | multimodal | voice`),
`chat=true` for chat-visible entries only.

Every entry is serialized `object: 'model'` and `owned_by: 'alia'`
(`packages/api/src/routes/v1/models.ts:22`, `:24`). Several of them are routing policies
rather than models; [model abstraction](./model-abstraction.mdx) says which, and ADR 0003
records the vocabulary that fixes it.

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

All `/automations*` endpoints were removed outright; use `/triggers`.

---

## Error contract

- User-facing errors pass through `sanitizeMessage()`
  (`packages/api/src/lib/errors/sanitize.ts`). It applies two rules. The first is
  absolute and holds on every surface: no credential, no internal endpoint and no raw
  upstream error body. The second conceals upstream operator names and model ids, and is
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
- **Whether `/v1/shows` belongs to the compatibility window at all.** It is mounted with
  `optionalAuth` and is not obviously generic inference. *Owner: workstream 1 owner.*
