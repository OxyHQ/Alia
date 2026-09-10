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
`authenticateTokenOrApiKey` at `:221`): an Oxy **user session token** and an Oxy
**service token** (`:293`, through `@oxy.so/core`'s `oxy.auth()`, which validates the
session against Oxy and verifies a service token against Oxy's JWKS), and — deprecated —
an existing **`alia_sk_*`** key (`:287`). An **Oxy Console application key (`oxy_sk_*`) is
not accepted yet**: it is not a JWT, `oxy.auth()` refuses it `401 INVALID_TOKEN_FORMAT`,
and `@oxy.so/core` 1.0.1 has no lane for it (its own `server/auth.js` says the lane lives
in the Oxy API until *"the machine principal's shape"* moves into the package). That path
is built in Oxy first (`OxyHQ/oxy#972`), then in `@oxy.so/core/server`, then adopted here.
Until then a third-party application calls Alia's API with the signed-in user's Oxy
session — which is what `@alia.onl/sdk` already attaches.

The rest of this page is for people who **already hold an `alia_sk_*` credential** and
need to know what still works, what has stopped, and how the credential is retired. The
decisions behind that are [ADR 0001](./adr/0001-alia-oxy-kaana-responsibility-boundary.md)
(Oxy owns accounts, applications and credentials),
[ADR 0004](./adr/0004-product-endpoints-versus-generic-inference-endpoints.md) (no new
`alia_sk_*`, no provider billing in Alia — its sunset clause is amended by ADR 0010) and
section (c) of [`docs/migration/compatibility-window.md`](./migration/compatibility-window.md),
which carries the clock and its gate. The page is kept, rather than deleted, because a live
credential with no documentation is worse for its holder than a deprecated page.

## What still works today

Everything below is the current behaviour of `api.alia.onl`, verified against the code.

**Applications and keys.** `/developer` (`packages/api/src/routes/developer.ts`, mounted in
`packages/api/src/index.ts` behind `authenticateToken` and workspace resolution) serves
everything except creation:

| Route | Purpose |
|---|---|
| `GET /developer/apps` | List the caller's apps, scoped by the `X-Workspace-Id` header |
| `GET /developer/apps/:id` | One app |
| `POST /developer/apps` | **Closed.** `410 Gone`, `error: "issuance_closed"` |
| `PATCH /developer/apps/:id` | Update an app |
| `DELETE /developer/apps/:id` | Delete an app |
| `GET /developer/apps/:appId/keys` | List an app's keys |
| `POST /developer/apps/:appId/keys` | **Closed.** `410 Gone`, `error: "issuance_closed"` |
| `PATCH /developer/apps/:appId/keys/:keyId` | Update a key — name, scopes, active flag, limits |
| `DELETE /developer/apps/:appId/keys/:keyId` | Revoke a key |
| `GET /developer/apps/:appId/keys/:keyId/rate-limits` | Read a key's limits |
| `PATCH /developer/apps/:appId/keys/:keyId/rate-limits` | Change a key's limits |
| `GET /developer/apps/:appId/usage` | Per-app usage, `?period=7d` |
| `GET /developer/apps/:appId/keys/:keyId/usage` | Per-key usage |
| `GET /developer/usage` | Usage across the caller's apps |
| `GET /developer/stats` | Aggregate stats |

**The desktop authorization flow, which was the second minting path.** Earlier revisions of
this page described `POST /developer/apps/:appId/keys` as the way a key came into
existence. It was not the only one. `packages/api/src/routes/auth.ts` carried a complete
PKCE exchange that registered an Alia developer application per user and then minted — or
silently replaced the secret of — a key, for any caller able to complete the challenge:

| Route | Was | Now |
|---|---|---|
| `POST /auth/authorize/codea` | Register an "Alia Codea" app, return an authorization code | **Closed.** `410 Gone` |
| `POST /auth/authorize/cowork` | Register an "Alia Cowork" app, return an authorization code | **Closed.** `410 Gone` |
| `POST /auth/token` | Exchange the code for a fresh `alia_sk_*` credential | **Closed.** `410 Gone` |

`POST /auth/me` and `POST /auth/logout` are unaffected.

Two shipped clients still call `POST /auth/token` to sign in —
`packages/alia-cowork/src/main/auth.ts` and `packages/alia-codea-cli/src/commands/auth.ts`.
They can no longer obtain a **new** credential; a credential they already hold keeps
authenticating for the whole window, so an installation that is already signed in is
unaffected. The replacement is not speculative:
`packages/alia-codea/src/authProvider.ts` already authenticates the VS Code extension
against Oxy's own `/auth/oauth/token`, and the other two clients follow it.

**Authentication.** An `alia_sk_*` credential authenticates every route under `/v1/*`
except `/v1/models`, which is mounted ahead of the auth middleware
(`packages/api/src/routes/v1.ts:28` and `:31`). `authenticateTokenOrApiKey` at `:59`
accepts a session token or a key; `apiKeyRateLimit` at `:62` applies the key's own limits.

**Scopes.** Eight, a closed set enforced by a Postgres CHECK constraint
(`packages/api/src/db/schema/developers.ts:17` through `:26`, constraint at `:112`):
`chat:read`, `chat:write`, `models:read`, `conversations:read`, `conversations:write`,
`conversations:delete`, `memory:read`, `memory:write`. New keys default to
`{chat:read, chat:write}` (`:96`). An empty scope array is permitted and reaches nothing,
which is a safe state rather than a bug.

**Key format and storage.** `alia_sk_` (`packages/api/src/lib/api-key-crypto.ts:21`) plus
32 random bytes as URL-safe base64 — 43 characters, 51 in total. Only the SHA-256 digest is
stored (`:37`); the first 16 characters are kept separately for display
(`routes/developer.ts:224`). The full key is returned once, at creation, and never again.
The digest is deterministic because it is a lookup key: authentication hashes the presented
key and looks it up by digest.

**Usage records.** Every authenticated request is recorded in `api_key_usage`
(`packages/api/src/db/schema/telemetry.ts:257`) with endpoint, method, status code,
`auth_type` (`api_key | session | internal`), key id and app id. Rows are swept at 90 days
from `timestamp` (`packages/api/src/db/expiryTargets.ts:107`).

**Where the UI lives.** The developer console is `packages/alia-console`, a TanStack Start
app: apps, keys, usage, billing, playground and the documentation pages. There is no
developers section in the Expo app — the `app/(developers)/*` screens described by earlier
revisions of this page were removed.

## What has stopped, or is stopping

Under ADR 0004 (as amended by ADR 0010) and section (c) of the compatibility window:

- **No new `alia_sk_*` credential is issued.** The set of Alia developer credentials is
  closed. All three creation paths refuse with `410 Gone` and a body naming Oxy Console.
  This is enforced rather than agreed: `generateDeveloperApiKey` has been deleted from
  `packages/api/src/lib/api-key-crypto.ts`, so no code in the service can produce a key;
  `insertApiKey` and `insertApp` have been deleted from the repository, so no code can
  write one; and `DeveloperApiKeyUpdate` cannot name `keyHash`, so no code can replace an
  existing key's secret either — which is issuance wearing maintenance's clothes.
- **No new Alia developer application** is created, for generic inference or otherwise.
  Every application this surface registered existed to hold `alia_sk_*` keys.
- **The `/v1` route list is frozen, not shrinking.** `api.alia.onl/v1/*` is permanent
  (ADR 0010); its fifteen routes are frozen by name in
  `packages/api/src/routes/__tests__/v1-compatibility-surface.test.ts`, and adding one is a
  deliberate edit of that list. Generic model access is a different product — Kaana
  through Oxy at `api.oxy.so/v1` — not a replacement for this one.
- **Alia stops settling inference charges** for this surface. Usage is metered by Kaana and
  charged through the Oxy ledger ([ADR 0005](./adr/0005-product-entitlements-versus-financial-ledger.md)).

Revocation, listing and inspection of **existing** keys stay available for the whole
window (not rotation — none has ever existed on `/developer`, see above). Removing
revocation during a migration would be a security regression.

## Calling Alia's API with an existing key

While the credential window is open, an existing key authenticates as it always did:

```bash
curl -X POST https://api.alia.onl/v1/chat/completions \
  -H "Authorization: Bearer alia_sk_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "profile:auto",
    "messages": [{ "role": "user", "content": "Hello, Alia!" }]
  }'
```

```javascript
const response = await fetch('https://api.alia.onl/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer alia_sk_your_key_here',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'profile:auto',
    messages: [{ role: 'user', content: 'Hello!' }],
  }),
});
```

Two things to know about the responses:

- The stream carries `alia.*` product events (see
  [the chat runtime page](./chat-runtime.mdx)). They are part of Alia's product API and
  **not** of the Oxy generic inference contract; a client written against them is an Alia
  client, which is the point.
- `model` takes a routing-profile identifier from `GET /catalogue`. The thirteen `alia-*`
  aliases are path (a) of the compatibility window; see
  [model abstraction](./model-abstraction.mdx) for what each one was and how it is retired.

Scopes required: `chat:write` for `/v1/chat/completions`, `models:read` for `/v1/models`.

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
[`packages/alia-chat/README.md`](../packages/alia-chat/README.md). Do not build it on an
`alia_sk_*` key: the route accepts one, but issuance is closed and the credential is
inside its own window above. A consumer-application credential for this route is Oxy
Applications' to issue (`OxyHQ/oxy#972`).

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
| The assistant — conversations, memory, agents, tools, approvals, research, triggers, the `alia.*` stream | Alia's product API: `api.alia.onl/v1/*` or `/alia/chat`, with the Oxy credential above; Alia's own catalogue of routing profiles at `GET /catalogue` |

Alia does not own a generic model catalogue, and it does not hold the authoritative
balance for anything.

## Removal gate

`alia_sk_*` credentials are section (c) of the compatibility window document. All three
conditions must hold before removal:

1. Every key owner has been notified, with the notification recorded. Response headers are
   not sufficient on their own: an owner who never calls the API in the window never sees
   one.
2. A measurement over `api_key_usage` filtered to `auth_type = 'api_key'`, across a window
   shorter than the 90-day retention, showing zero authenticated requests — with a positive
   control on `auth_type = 'session'` traffic over the same window. *Or* an enumeration
   showing every active key has been revoked by its owner or mapped to an Oxy
   ApplicationCredential.
3. No active row remains in `developer_api_keys` unaccounted for by (2), checked against
   `is_active` and `last_used_at` (`packages/api/src/db/schema/developers.ts:98`) rather
   than against traffic alone. An unused key is still a live credential.

A stored key digest is never handed back as a replacement secret. Migration means the owner
obtains a **new** Oxy credential.

The `api.alia.onl/v1/*` routes themselves have **no** gate: they are Alia's permanent
product API (ADR 0010), and section (b) of the same document records the withdrawal of
the per-route gate it used to carry. Only the credential is retired.

The clock owner is the owner of workstream 11 of #139, recorded on the epic.

## Deprecation signal

Every path inside the window emits `Deprecation` (RFC 9745) and `Sunset` (RFC 8594)
response headers with a `Link` to the migration documentation, plus an `alia.deprecation`
stream event. Emitting them is a prerequisite for starting the clock, not an optional extra
— a window that runs without a signal surprises its callers at the end.

For credentials the headers exist: `packages/api/src/middleware/credential-deprecation.ts`,
mounted app-wide, emits them on any response to a request that presents an `alia_sk_*`
credential, and `refuseIssuance` emits them on every closed creation path. The signal fires
on **presentation** rather than on successful authentication — the middleware runs before
auth, and a caller whose key has lapsed is exactly the caller who needs the notice.

Two things are still missing, and neither is this page's to fix: the `alia.deprecation`
stream event does not exist for any path, and the direct notification to each key owner has
not been sent. Headers alone cannot be the whole notice for a credential — an owner who
never calls the API in the window never sees one — so the removal gate below is not
satisfiable until that notification happens. It is blocked on Oxy shipping the
Applications/Console side (`OxyHQ/oxy#972`), because there is nowhere to migrate a key to
until then.

A `Sunset` value appears only once a removal date is set, and a date is set only when the
gate is satisfied or credibly close. An announced date that then moves teaches callers to
ignore the header.

## Troubleshooting

**A key stops authenticating.** Check, in order: the key is active; it has not expired; the
owning app is active; the request carries the scope the route requires; the header is
`Authorization: Bearer alia_sk_…`.

**Usage stats look empty.** Usage is recorded after the response, so allow a few seconds.
Only requests that authenticated successfully are recorded. Rows older than 90 days are
swept.

**Key creation fails with `410` and `"error": "issuance_closed"`.** That is the freeze, not
a fault. Alia issues no new credentials; register an application in Oxy Console. The
response carries a `Link` header and a `documentation` field pointing at the migration
document.

**A desktop client cannot sign in.** Cowork and the Codea CLI obtained their credential
from `POST /auth/token`, which is closed. An installation already holding a credential
keeps working; a new sign-in needs the client migrated to Oxy's own OAuth, as the VS Code
extension already is.

## Open questions

- **The notification channel for key owners.** Whether it is Alia notifications, Oxy
  account email, or both. *Owner: workstream 11 owner.* Blocked on `OxyHQ/oxy#972`: the
  notification has to name a destination, and there is none until Oxy Applications exists.

## Decided

- **Whether the key-creation endpoint refuses or is removed: it REFUSES.** Removing the
  route is cleaner in the diff and worse for everyone reading the response. A removed route
  answers with the framework's default `404`, which is indistinguishable from a typo, a
  stale base URL or an outage, and carries nothing a developer can act on. Refusing keeps
  the shape, returns `410 Gone` — the same answer this API already gives for
  `POST /v1/resolve-model` and `POST /v1/report-usage` — and carries the subject, the
  message and the link. *Decided by workstream 11 of #139.*
