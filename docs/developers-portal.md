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

**Authentication contract:** signed-in users and existing delegated service callers continue through the canonical Oxy SDK. `alia_sk_*` remains retired. The proposed Console machine lane below requires the coordinated Oxy API and core server release; the existing registry package alone does not provide it.

A Console `oxy_sk_*` may enter only POST `/alia/chat` or `/v1/chat/completions` when **both the application and its machine credential explicitly carry `alia:chat` and `inference:invoke`** in the current environment. The recipient is Alia's registered resource identity, checked by Oxy. It is an app-only turn: messages and generation options, no user's agents, conversation, memory, local runtime, tools or delegated user headers. The key does not become its owner's user session or an internal service. Oxy inference revalidates the same caller credential and charges the calling application, never Alia's default payer. Existing keys without the two scopes are denied; no default grants are introduced.

Before this candidate, the actual HTTP entry returned `401 Unauthorized` for a raw Console key, with canonical observer `INVALID_TOKEN_FORMAT`; that observer was not the public HTTP error body. The fix reuses `OxyServer.apps.introspectAliaMachineCredential` and its server middleware, not a product-local credential resolver. See the [machine chat contract](./machine-chat-contract.md) for release order and limits.

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
conversation runtime parses the `alia.*` stream events above and stores conversations. It speaks
only to `/v1` — `POST /v1/chat/completions` for a turn and `/v1/conversations` for the history —
with the signed-in person's Oxy bearer and no cookies, on a surface with public CORS, so it works
in the browser of any Oxy app on its own origin. There is nothing to relay or configure.

`/v1/conversations` admits a person's session only (not an application key or a bot secret): a
conversation is somebody's private history. Applications that want inference without conversations
keep using `POST /v1/chat/completions` directly. A consumer-application credential for the
conversation routes is not planned; the retired `alia_sk_*` keys are refused.

## Where new integrations go

| You want | Go to |
|---|---|
| An application, its credentials and its browser origins | Oxy Console — for Alia's API, Kaana's and Mention's alike |
| Raw model access — a completion with nothing around it | Kaana through Oxy: `api.oxy.so/v1` |
| The generic model catalogue | The Oxy catalogue |
| Usage and invoices | Oxy |
| The assistant — conversations, memory, agents, tools, research, automations, the `alia.*` stream | Alia's product API: `api.alia.onl/v1/*` or `/alia/chat`, with the Oxy credential above; the models its chat can use — Oxy's catalogue filtered to text models with tools — at `GET /catalogue` |

Alia does not own a generic model catalogue, and it does not hold the authoritative
balance for anything.
