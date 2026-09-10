# 10. Alia keeps a product API; credentials come from Oxy Console

**Status:** Accepted

**Date:** 2026-09-10

## Context

[ADR 0006](./0006-the-destination-of-api-alia-onl-v1-is-recorded-twice.md) recorded
that this repository stated two destinations for `api.alia.onl/v1/*` — permanent, in four
derived notes under `docs/migration/`; bounded and sunsetting, in
[ADR 0004](./0004-product-endpoints-versus-generic-inference-endpoints.md) §3 and
twenty-five artifacts that follow it — and asked the repository owner for one sentence.
This record is that sentence, and what follows from it.

**The owner's decision, 2026-09-10, is the source of this ADR.** In the owner's words:

> Kaana is the AI inference API — the Cerebras/OpenRouter of Oxy. Oxy is the platform
> (accounts, identity, billing) AND Oxy Console, where ALL the ecosystem's APIs and API
> keys are managed — for Alia, Kaana, Mention, everything — like Google Cloud Console.
> Alia is the ChatGPT of Oxy; it is also used from other apps in the ecosystem, so it has
> its own API. API keys to use Alia's API, Kaana's or Mention's are all issued from Oxy
> Console.

Three roles, then, none of which is a subset of another:

- **Kaana** is the inference API: models only. Provider credentials live there
  (ADR 0001; `docs/inference/request-routing.md` in the Oxy repository).
- **Oxy** is the platform and Oxy Console: accounts, identity, applications, **all** API
  keys for Alia, Kaana and Mention, billing.
- **Alia** is the assistant product, with its own permanent product API. Its callers are
  three groups, all authorized by Oxy: Alia's **own surfaces** — the app, Codea (the VS
  Code extension and the CLI) and Cowork, which are Alia products, not external ones;
  **other applications in the Oxy ecosystem**; and **third parties** through
  `@alia.onl/sdk`. Any API key among them is issued in Oxy Console.

ADR 0004 was right about everything except the sunset. It read `POST /v1/chat/completions`
as *"a generic OpenAI-compatible inference endpoint for external developers"* and, since
ADR 0001 assigns generic inference to Oxy, concluded the surface had to go. The conflation
is in that reading: Alia's API is not a generic inference API that happens to carry product
semantics; it is a **product API** — conversations, memory recall, agent planning, tool
execution and approvals, deep research, the `alia.*` SSE events — that happens to accept an
OpenAI-compatible request shape. What ADR 0001 moves to Oxy and Kaana is raw model access.
That was never the thing `@alia.onl/sdk`, Codea, Cowork or the CLI were calling for.

### What the code does today

Measured on the tree this ADR lands in.

- `POST /alia/chat` and `POST /v1/chat/completions` are one handler:
  `packages/api/src/routes/chat.ts` imports `handleChatCompletions` from
  `routes/v1/chat-completions.ts` and both routers are mounted side by side at
  `packages/api/src/index.ts:248` and `:249`. Both carry `authenticateTokenOrApiKey` and
  `apiKeyRateLimit` (`routes/chat.ts`, `routes/v1.ts:55` and `:58`). Alia's own surfaces
  post to `/alia/chat` with the user's Oxy session: the app
  (`packages/app/lib/api/routes.ts:67`), Codea (`packages/alia-codea/src/chatParticipant.ts:206`),
  the CLI (`packages/alia-codea-cli/src/utils/api.ts:152`) and Cowork
  (`packages/alia-cowork/src/main/chat.ts:164`). `@alia.onl/sdk` enters through
  `/v1/chat/completions` (`packages/alia-chat/src/hooks/useAliaChat.ts`).
- `authenticateTokenOrApiKey` (`packages/api/src/middleware/auth.ts:221`) accepts, in order:
  a request already authenticated by a channel-bot pre-middleware; a Telegram or channel bot
  secret; the internal `SERVICE_SECRET` (`:268`); an existing `alia_sk_*` key (`:287`,
  dispatched to `authenticateApiKey` at `:117`, which hashes the key and looks it up in
  `developer_api_keys`); and otherwise an Oxy bearer through `authenticateToken` (`:293`),
  which is `createOxyAuthMiddleware` from `@oxy.so/core/server` (`:54`).
- That Oxy bearer path is `oxy.auth()` in `@oxy.so/core` 1.0.1
  (`node_modules/@oxy.so/core/dist/esm/mixins/OxyServices.utility.js:231`). It
  `jwtDecode`s the bearer; a token that is not a JWT is refused `401 INVALID_TOKEN_FORMAT`.
  A user token must carry a `sessionId`, which is validated against Oxy on every request; a
  `type: 'service'` token is verified against Oxy's JWKS and may delegate through
  `X-Oxy-User-Id`. **No branch accepts an Oxy Console application API key.** The same
  package says so about itself: the `oxy_sk_*` machine-credential lane of OxyHQ/oxy#972
  §2.3 resolves only inside the Oxy API into `req.machineCredential`, and moving it into
  `@oxy.so/core` *"needs the machine principal's shape to move into this package first"*
  (`node_modules/@oxy.so/core/dist/esm/server/auth.js:38`–`49`).
- Issuance of Alia credentials is closed. `POST /developer/apps` and
  `POST /developer/apps/:appId/keys` call `refuseIssuance`
  (`packages/api/src/routes/developer.ts:85`, `:186`), as do the three `/auth` routes that
  were the second minting path (`routes/auth.ts:94`, `:98`, `:116`); the answer is
  `410 Gone` with `error: 'issuance_closed'` and a body naming Oxy Console
  (`middleware/credential-deprecation.ts:151`–`154`, `:168`, `:190`). Existing keys still
  authenticate, and every response to a request presenting one carries `Deprecation` and
  `Link` (`credentialDeprecationHeaders`, mounted app-wide at `index.ts:197`).
- The two mounts answer browsers differently. `/v1` has `cors({ origin: '*' })`
  (`index.ts:117`); every other path goes through the exact-origin allowlist built by
  `createInternalCors` (`lib/cors-origins.ts`, mounted at `index.ts:139`–`143`), so a
  preflight to `/alia/chat` from an origin Alia does not enumerate gets no
  `access-control-allow-origin`. Pinned by
  `packages/api/src/middleware/__tests__/chat-origin-policy.test.ts`.

## Decision

### 1. Alia's HTTP API is a permanent product API

`api.alia.onl/v1/*`, and `/alia/chat` with it, **does not sunset**. It is the product API
of the assistant: the OpenAI-compatible request shape, the `alia_usage` / `alia_meta`
extensions, `system_fingerprint: 'fp_alia'`, the named `alia.*` SSE events, and every
product behaviour behind the handler. It has three groups of callers, and that is the
reason it exists rather than a compatibility accident: **Alia's own surfaces** — the app,
Codea (extension and CLI) and Cowork, which are Alia products and use `/alia/chat` today
with the user's Oxy session; **other applications in the Oxy ecosystem**; and **third
parties** through `@alia.onl/sdk`. All three are authorized by Oxy, and any API key among
them is issued in Oxy Console. Codea and Cowork are not "external" or "ecosystem" callers
and are not described as such anywhere in this repository's documentation.

ADR 0006 is answered: `docs/migration/ownership.md` § *Product API* and the matrix rows
`v1-chat-completions-post` and `v1-router-mount` were right that the API stays. ADR 0004 §3
(*"a bounded-window compatibility surface, then it sunsets"*) and its rejected alternative
(*"Keep `api.alia.onl/v1/*` permanently as a product-branded inference API"*) are
superseded on that one point. ADR 0004's other three conditions — it authenticates
through Oxy, it issues no new `alia_sk_*`, it settles no provider billing in Alia — stand,
and are now permanent properties of the surface rather than terms of a window.

Path **(b)** of `docs/migration/compatibility-window.md` therefore ceases to be a
compatibility path. It has no deprecation signal, no removal gate and no clock, by decision
rather than by omission. Paths (a) and (c) are untouched.

**Generic inference is still Oxy's, backed by Kaana.** A developer who wants raw model
access uses Kaana through Oxy — Oxy Console for the application and the key,
`api.oxy.so/v1` for requests, the Oxy catalogue for models. A developer who wants Alia —
its conversations, memory, agents, tools and research — uses Alia's API. Both hold a
credential from Oxy Console. Neither statement is written as *"instead of"* the other
again; they are different products.

This ADR does not decide where new product routes are mounted. The route list frozen by
`packages/api/src/routes/__tests__/v1-compatibility-surface.test.ts` stays frozen: adding
a route to `/v1` is a deliberate edit of that list under review, not a consequence of
permanence, and the product routes that already live beside `/v1` (`/conversations`,
`/shows`, `/skills`, `/agents`, `/library`, `/catalogue`) are as much Alia's product API as
`/v1/chat/completions` is.

### 2. Credentials come from Oxy Console, never from Alia

A key to call Alia's API is an Oxy application credential, issued in Oxy Console and
validated by Alia against Oxy. Alia issues nothing. What sunsets is Alia's own credential
system: the `alia_sk_*` keys, the `developer_apps` and `developer_api_keys` tables, the
`/developer` routes that manage them, and the key screens of the developer console. All of
it remains frozen and migration-only, exactly as section (c) of the compatibility window
and `docs/developers-portal.md` record, and it is removed on section (c)'s gate.

What that means today, stated precisely so nobody reads this ADR as a feature:

| Credential presented to `api.alia.onl` | Today | Source |
| --- | --- | --- |
| Oxy user session token | **Accepted.** Validated against Oxy on every request | `middleware/auth.ts:293`, `@oxy.so/core` `oxy.auth()` |
| Oxy service token (`type: 'service'`, optionally `X-Oxy-User-Id`) | **Accepted.** Verified against Oxy's JWKS | same path |
| Existing `alia_sk_*` key | **Accepted, deprecated.** No new one is issued | `middleware/auth.ts:287`, `routes/developer.ts:85`, `:186` |
| Oxy Console application API key (`oxy_sk_*`) | **Not accepted.** Not a JWT; refused `401 INVALID_TOKEN_FORMAT`. No code in Alia or in `@oxy.so/core` 1.0.1 resolves it | `OxyServices.utility.js:270`–`292`; `server/auth.js:38`–`49` |

**Still to be built, and marked as such:** the Oxy-issued application-key path on Alia's
API. It lands in three places, in order — the key lane in the Oxy API (OxyHQ/oxy#972),
its verifier in `@oxy.so/core/server` so that every app backend validates the same way
(the Oxy monorepo's `AGENTS.md`: missing auth behaviour *"belongs in
`@oxy.so/core/server`"*, never in an app), then its adoption in
`packages/api/src/middleware/auth.ts` in place of the
`alia_sk_*` branch. Until the first two exist, a third-party application calls Alia's API
with an Oxy user session token — which is what `@alia.onl/sdk` already attaches — and the
`alia_sk_*` branch keeps serving the keys already in circulation.

### 3. Browser origins for third-party applications are registered in Oxy Console

An application that embeds `@alia.onl/sdk` on its own web origin needs `/alia/chat` to
answer its preflight. The registry for that origin is the application's record in Oxy
Console (OxyHQ/oxy#972), not an Alia allowlist and not the closed `developer_apps` table.
Until that registry exists, the supported path is the consumer-backend relay recorded in
`packages/alia-chat/README.md` and `docs/migration/compatibility-window.md` § *(b)*: the
consumer's backend calls `POST /alia/chat` server-to-server, where there is no `Origin`
header, and streams the body back.

The two CORS policies stay as measured — `/alia/chat` exact-origin, `/v1` wildcard — and
`chat-origin-policy.test.ts` keeps pinning them. When oxy#972 lands, the per-application
origin list replaces the `/v1` wildcard: a registered application's origin is answered on
both mounts, an unregistered one on neither. That change is taken deliberately against the
pinned test, not by widening `lib/cors-origins.ts`.

## Consequences

- **ADR 0004 is amended, not rewritten.** A note at its top says which sentence no longer
  holds; its body stays as the record of the decision as taken. ADR 0006 moves to
  *Superseded by 0010* with a pointer, body intact.
- **`docs/migration/compatibility-window.md` § (b) becomes a resolution, not a gate.** Its
  removal gate, signal and clock are withdrawn; the `/v1/shows` history and the #244
  subsection stay, updated. The document's open question *"whether (b) is permanent or
  sunsets"* closes.
- **`ownership.md` § *Product API*, `ownership-matrix.json` rows `v1-chat-completions-post`,
  `v1-router-mount` and `sdk-chat-consumer`, and the two matching gates in
  `inventories/product-api.json`** drop their `CONTESTED` notes. Their gate reads: *not
  removed — permanent product API (ADR 0010); what is removed is the `alia_sk_*`
  credential path, on its own gate.*
- **On #139, line 318** (*"remains a product-specific compatibility endpoint for a bounded
  period"*) no longer describes the outcome, as ADR 0006 predicted: the epic needs a fourth
  option under line 316, *"is Alia's permanent product API; credentials move to Oxy
  Console"*. Line 315 (*"Move generic inference access to `api.oxy.so/v1` backed by
  Kaana"*) survives unchanged. `docs/migration/epic-139-decisions.md` O1 carries the note.
- **Issue #244 closes as decided.** Shape (b) — the SDK default moving to `/alia/chat` in a
  major — is no longer needed to escape a sunset, and is taken only if the per-application
  origin policy of §3 makes it worthwhile. Shape (a) is oxy#972's. Shape (c) is supported
  today.
- **Sixteen code comments still say the surface sunsets**, listed in ADR 0006 under *Code
  and executable gates*. None is load-bearing — the two executable gates freeze the
  surface's shape and caller set, which permanence also wants, and stay green — but each
  is a stale rationale a reader will treat as current. They are corrected as the files are
  next touched; `packages/api/src/index.ts:227`–`228` (`/media`) and
  `routes/catalogue.ts:28` are the two a reader meets first.
- **`@alia.onl/sdk` keeps its `/v1/chat/completions` default.** Its consumers no longer sit
  on a surface with a removal gate. Its README says why it is on `/v1` (CORS) without
  saying the surface is bounded.
- **The developer-facing documentation changes audience again.** ADR 0004 sent every
  developer to Oxy. This ADR sends developers who want a model to Kaana through Oxy, and
  developers who want the assistant to Alia's API — with a key from Oxy Console in both
  cases. `docs/developers-portal.md` now says that, and stays the page for holders of an
  `alia_sk_*` key.

## Alternatives considered

**Keep ADR 0004 and correct the four derived notes.** Rejected by the owner. It rests on
reading Alia's API as generic inference; the owner's statement is that Alia *"is also used
from other apps in the ecosystem, so it has its own API"*. Correcting the notes would have
removed the only artifacts that described the intended end state.

**Proxy `api.alia.onl/v1/*` to `api.oxy.so/v1` for good.** Rejected, and for a stronger
reason than ADR 0004 gave. Kaana does not implement conversations, memory, agents, tools,
approvals or the `alia.*` events; a proxy to it is not the same API under another
implementation, it is a different API that loses everything the callers came for.

**Let Alia issue keys for its own API, now that the API is permanent.** Rejected. The
owner's rule is that *all* ecosystem keys are managed in Oxy Console; an Alia-issued key
is a second console, and `developer_apps` is what a second console looks like after two
years. The issuance closure and the deleted key generator stay exactly as they are.

**Write the permanence into ADR 0004 by editing it.** Rejected by `docs/adr/README.md`:
an accepted ADR is not edited to change its decision. The amendment note at its top is a
pointer, not a rewrite.

## Enforcement

- **The surface's shape and caller set:** `packages/api/src/routes/__tests__/v1-compatibility-surface.test.ts`
  walks the mounted `/v1` router, freezes its route list and asserts the auth chain by
  middleware identity. A route removed without editing that list fails it; so does a
  lookalike auth wrapper. Unchanged by this ADR; its rationale text still cites the window
  and is corrected when next touched.
- **No new Alia-issued credential:** `packages/api/src/middleware/__tests__/credential-deprecation.test.ts`
  censuses the tree for a key generator, an insert into the developer tables and a
  `keyHash` update; all three are absent and stay absent.
- **The two CORS policies:** `packages/api/src/middleware/__tests__/chat-origin-policy.test.ts`
  reproduces `index.ts`'s wiring and drives both mounts over a socket. Replacing the `/v1`
  wildcard with a per-application list under §3 is done by changing that test on purpose.
- **Not enforced, and said so:** the Oxy-issued application-key path of §2 has no test
  because it has no code — in this repository or in `@oxy.so/core` 1.0.1. When it lands,
  the acceptance half belongs in `v1-compatibility-surface.test.ts` beside the
  `alia_sk_*` branch it replaces.
- **Not enforced, and said so:** no check compares a destination asserted in
  `docs/migration/*` with the ADR that decides it, as ADR 0006 recorded. The check it
  sketched now points the other way — *no row whose `currentPath` is under
  `packages/api/src/routes/v1/` carries a removal gate that sunsets the route* — and is
  not written.
- **Review rule:** a change that removes a `/v1` route cites a product decision taken after
  this ADR, not ADR 0004; a change that mints, rotates or accepts a new Alia-issued
  credential is rejected on sight; a change that widens `lib/cors-origins.ts` to admit a
  third-party origin is rejected in favour of the Oxy Console registry.
