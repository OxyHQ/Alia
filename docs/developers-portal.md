# Developer access to Alia

Three products, three roles, one console
([ADR 0010](./adr/0010-alia-keeps-a-product-api-credentials-come-from-oxy-console.md)):

- **Kaana** is the inference API — models only. Provider credentials live there.
- **Oxy** is the platform and **Oxy Console** — accounts, applications, **every** API key
  in the ecosystem (Alia's, Kaana's, Mention's), billing.
- **Alia** is the assistant, with its own **permanent product API** at `api.alia.onl`:
  `/v1/*` and `/alia/chat` (one handler), plus `/conversations`, `/shows`, `/skills`,
  `/agents` and `/catalogue`. Three groups call it, all authorized by Oxy: Alia's own
  surfaces — the app, Codea (the VS Code extension and the CLI) and Cowork, which are Alia
  products and use `/alia/chat` with the user's Oxy session; other applications in the
  Oxy ecosystem; and third parties through `@alia.onl/sdk`. It accepts an
  OpenAI-compatible request shape and streams `alia.*` product events; it does not sunset.

**Pick the product, then get the key from Oxy Console.** For raw model access — a
completion with no conversation, memory, agents or tools around it — use Kaana through
Oxy: `api.oxy.so/v1`, the Oxy catalogue for models. For the assistant, use Alia's API.
Neither is a substitute for the other, and Alia issues no keys for either.

**What Alia's API accepts today, precisely** (`packages/api/src/middleware/auth.ts`,
`authenticateTokenOrApiKey`): an Oxy **user session token** and an Oxy **service token**
(through `@oxy.so/core`'s `oxy.auth()`, which validates the session against Oxy and
verifies a service token against Oxy's JWKS). An **`alia_sk_*`** key is **refused**,
`401 credential_retired` — see below. An **Oxy Console application key (`oxy_sk_*`) is
not accepted yet**: it is not a JWT, `oxy.auth()` refuses it `401 INVALID_TOKEN_FORMAT`,
and `@oxy.so/core` 1.0.1 has no lane for it (its own `server/auth.js` says the lane lives
in the Oxy API until *"the machine principal's shape"* moves into the package). That path
is built in Oxy first (`OxyHQ/oxy#972`), then in `@oxy.so/core/server`, then adopted here.
Until then a third-party application calls Alia's API with the signed-in user's Oxy
session — which is what `@alia.onl/sdk` already attaches.

## Alia-issued keys (`alia_sk_*`) are retired

The owner decided a clean cut, with no rollback window, accepting that anyone still
presenting an `alia_sk_*` key stops working. Issuance had already been closed under
[ADR 0004](./adr/0004-product-endpoints-versus-generic-inference-endpoints.md) and
[ADR 0010](./adr/0010-alia-keeps-a-product-api-credentials-come-from-oxy-console.md);
acceptance went too:

- **Every request presenting one is refused.** `authenticateTokenOrApiKey` answers
  `401` with `"error": "credential_retired"` before the Oxy SDK sees the token, on
  `/alia/chat`, `/v1/*` and every other route behind it. The MCP relay has no key lane.
- **The developer platform is gone.** Every `/developer/*` route (applications, keys,
  rate limits, usage, stats), every `/codea/*` route, and the `POST /auth/authorize/codea`,
  `POST /auth/authorize/cowork` and `POST /auth/token` refusals were deleted; they answer
  `404`. The `packages/alia-console` developer portal was deleted with them.
- **The data is gone.** Migration `0070_clean_cut_dormant_tables` drops
  `developer_apps` and `developer_api_keys`. `api_key_usage` keeps its historical rows —
  `auth_type = 'api_key'` with the key and app ids — and records only session and
  internal traffic from now on.
- **The clients moved first.** The Codea extension, the Codea CLI and Cowork all sign in
  with Oxy; the extension's "Enter API key" option and its `codea.apiKey` setting are
  removed.

Section (c) of [the compatibility window](./migration/compatibility-window.md) is closed.

## Using `@alia.onl/sdk` from your own application

`@alia.onl/sdk` (`packages/alia-chat`) is a **product** client, not a generic one: its
`useAliaChat` hook parses the `alia.*` stream events above. It nevertheless defaults to
`POST /v1/chat/completions`, because the product route, `POST /alia/chat`, answers CORS
preflights only for Alia's own origins (`packages/api/src/lib/cors-origins.ts`) while
`/v1` answers `*`, and the SDK ships raw source that compiles into your app on your
origin. Pointing it at `/alia/chat` from a browser would fail your preflight.

The supported way to use the SDK from an application outside Alia's origins today is
**through your own backend**. It receives the SDK's request, calls `POST /alia/chat`
server-to-server — no `Origin` header, so no CORS decision — forwarding the
`Authorization: Bearer …` header the SDK attached (the signed-in user's Oxy session, which
Alia verifies with Oxy exactly as it would for a direct call, and meters to that user), and
streams the `text/event-stream` body back unchanged. Then:

```tsx
useAliaChat({ apiUrl: 'https://your-backend.example' });
```

The hook appends its own paths, so your backend answers `POST /v1/chat/completions` and
`GET /catalogue` under that base URL. The minimal relay is in
[`packages/alia-chat/README.md`](../packages/alia-chat/README.md). A
consumer-application credential for this route is Oxy Applications' to issue
(`OxyHQ/oxy#972`); the retired `alia_sk_*` keys are refused.

The cost is one more hop in the path of every stream. The shape that removes it is a CORS
policy for the origins registered on your application in Oxy Console, blocked on that
registry existing (`OxyHQ/oxy#972`); once it does, the per-application origin list
replaces the `/v1` wildcard on both mounts (ADR 0010 § 3). The SDK default moving to
`/alia/chat` in a major is an adoption window rather than a switch and is no longer
needed to escape a sunset — `/v1/chat/completions` is permanent. Both shapes were recorded
in [#244](https://github.com/OxyHQ/Alia/issues/244), which closed on that decision.

## Where new integrations go

| You want | Go to |
|---|---|
| An application, its credentials and its browser origins | Oxy Console — for Alia's API, Kaana's and Mention's alike |
| Raw model access — a completion with nothing around it | Kaana through Oxy: `api.oxy.so/v1` |
| The generic model catalogue | The Oxy catalogue |
| Usage and invoices | Oxy |
| The assistant — conversations, memory, agents, tools, approvals, research, automations, the `alia.*` stream | Alia's product API: `api.alia.onl/v1/*` or `/alia/chat`, with the Oxy credential above; Alia's own catalogue of routing profiles at `GET /catalogue` |

Alia does not own a generic model catalogue, and it does not hold the authoritative
balance for anything.
