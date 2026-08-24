# Developer access to Alia

**If you are building a new integration, do not start here.** Generic model access is an
Oxy product: register an application in Oxy Console, obtain an Oxy ApplicationCredential,
and call `api.oxy.so/v1`. This page exists for people who already hold an Alia-issued
`alia_sk_*` credential and need to know what still works, what has stopped, and how the
credential is retired.

The decisions behind that split are recorded in
[ADR 0001](./adr/0001-alia-oxy-relay-responsibility-boundary.md) (Oxy owns accounts,
applications, credentials, the ledger and the public generic inference API) and
[ADR 0004](./adr/0004-product-endpoints-versus-generic-inference-endpoints.md) (Alia's
`/v1/*` becomes a bounded compatibility surface and then sunsets). The clock and its gates
are in [`docs/migration/compatibility-window.md`](./migration/compatibility-window.md).

None of the Oxy-side pieces are live yet. This page is kept, rather than deleted, because a
live credential with no documentation is worse for its holder than a deprecated page.

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

Under ADR 0004 and the compatibility window:

- **No new `alia_sk_*` credential is issued.** The set of Alia developer credentials is
  closed. All three creation paths refuse with `410 Gone` and a body naming Oxy Console.
  This is enforced rather than agreed: `generateDeveloperApiKey` has been deleted from
  `packages/api/src/lib/api-key-crypto.ts`, so no code in the service can produce a key;
  `insertApiKey` and `insertApp` have been deleted from the repository, so no code can
  write one; and `DeveloperApiKeyUpdate` cannot name `keyHash`, so no code can replace an
  existing key's secret either — which is issuance wearing maintenance's clothes.
- **No new Alia developer application** is created, for generic inference or otherwise.
  Every application this surface registered existed to hold `alia_sk_*` keys.
- **The surface gains nothing.** No new route, no new capability and no new model lands on
  `api.alia.onl/v1/*`. Generic inference development happens on `api.oxy.so/v1`.
- **Alia stops settling inference charges** for this surface. Usage is metered by Relay and
  charged through the Oxy ledger ([ADR 0005](./adr/0005-product-entitlements-versus-financial-ledger.md)).

Revocation, rotation, listing and inspection of **existing** keys stay available for the
whole window. Removing revocation during a migration would be a security regression.

## Calling the compatibility surface

While the window is open, an existing key authenticates as it always did:

```bash
curl -X POST https://api.alia.onl/v1/chat/completions \
  -H "Authorization: Bearer alia_sk_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "profile:v1",
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
    model: 'profile:v1',
    messages: [{ role: 'user', content: 'Hello!' }],
  }),
});
```

Two things to know about the responses:

- The stream carries `alia.*` product events (see
  [the chat runtime page](./chat-runtime.mdx)). They are **not** part of the Oxy generic
  inference contract and no generic client should be written against them.
- `model` accepts the thirteen `alia-*` identifiers, which are themselves inside the
  compatibility window. See [model abstraction](./model-abstraction.mdx) for what each one
  actually is and how they are retired.

Scopes required: `chat:write` for `/v1/chat/completions`, `models:read` for `/v1/models`.

## Where new integrations go

| You want | Go to |
|---|---|
| An application and credentials | Oxy Console |
| Generic inference requests | `api.oxy.so/v1` |
| The model catalogue | The Oxy catalogue |
| Usage and invoices | Oxy |
| Alia product behaviour — conversations, memory, agents, tools, approvals, research, triggers | The Alia product runtime |

Alia does not own a generic model catalogue once the Oxy catalogue launches, and it does
not hold the authoritative balance for anything.

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

The `api.alia.onl/v1/*` routes themselves are gated separately, route by route, under
section (b) of the same document — they have different consumers and empty at different
times. On removal a route returns `410 Gone` naming its replacement, following the pattern
`POST /v1/resolve-model` and `POST /v1/report-usage` already use.

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
