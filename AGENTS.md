# Alia

Multi-provider AI platform. Agent: `alia`.

> Org-wide engineering standards (package manager, TypeScript, React, naming,
> error handling, security, testing, git and PR conventions) live in
> <https://github.com/OxyHQ/engineering>. This file carries only what is true of
> Alia specifically. Versions are in `package.json`, never here.

## Deployment

Port `3001`, domain `api.alia.onl`, ECR `oxy/alia`. Built from the
`linux/arm64` Dockerfile in `packages/api/`.

## Monorepo structure

Non-standard layout: this repo does **not** use the three-package
`frontend`/`backend`/`shared-types` baseline that every other Oxy single-app repo
uses, so do not assume those paths.

`ls packages/` doesn't show: `app` is the Expo + NativeWind client, `api` the
Express backend, `alia-chat` is published as `@alia.onl/sdk`, and
`integrations` owns the MCP client. `packages/alia-codea/webview-ui` is its
own workspace entry, one higher than the directory listing suggests.

**CI is coupled to `api.github.com`** — `libsignal` resolves via a `github:`
dependency pinned to a commit; a 504 there fails `Install dependencies` or
`Set up job` with an error that looks nothing like a real dependency problem.

## Expo SDK override gotcha

The root `package.json`'s `overrides` block pins the Expo SDK tree-wide
(`expo`, `expo-font`, `expo-image`, `expo-modules-core`, `react-native`…),
beating whatever `packages/app/package.json` declares — which is why
**`bunx expo install --fix` loops forever**: the override resets the version
it just wrote. **Any Expo SDK bump touches THREE files:**
`packages/app/package.json`, the root `overrides`, and `bun.lock`.

## Model identity: scoped, not a global ban

**No rule says a provider or model name may never appear** — ADR 0003 makes
`<publisher>/<model>` canonical. What is scoped is where the PRODUCT hides route
detail: a UX and commercial decision, **not a security control**.

- **Conceal** through `sanitizeMessage()` on product API error bodies, SSE error
  events, the UI, notifications and customer-facing analytics.
- **Be truthful, never `sanitizeMessage()`,** on the catalogue and model
  cards, licence attribution, operator and audit surfaces (logs,
  `fallback_events`, admin console), the Relay contract's
  `providerError.provider`, and engineering docs, ADRs and schema comments.
- **Separate and absolute on every surface:** `redactUnsafeDetail()` — no
  credential, no internal endpoint, no upstream error code (`overloaded_error`
  names an operator as surely as the word does), plus redaction at birth
  (`internal/providers/lib/provider-error-body.ts`). The caller's own echoed
  input takes that alone, never `sanitizeMessage()`.
- Concealment matches IDENTIFIERS only, so ordinary prose survives; a new
  operator or upstream error code must be classified in `sanitize.ts`, and
  `sanitize.test.ts` goes red until it is.
- Analytics resolve via `getAliaModel()`, skipping entries that cannot resolve.
- **The thirteen `alia-*` ids are de-advertised (`GET /v1/models` → `[]`, ADR
  0003) but still ROUTABLE and BILLED** — `alia-models.ts` is untouched,
  `fallback-engine.ts` throws for anything outside `ALIA_MODELS`, and
  `credits-manager.ts` reads the alias's `credit_multiplier`. De-advertising
  satisfies no gate that would catch a REMOVAL. Extended reasoning is now a
  routing parameter (ADR 0002), not a model.

Key files: `internal/providers/lib/alia-models.ts` (the frozen `alia-*` set — see
`docs/model-abstraction.mdx`), `routes/v1/models.ts`, `lib/errors/sanitize.ts`,
and `packages/api/src/internal/` (all provider logic, CORS restricted).

## MongoDB database naming

Database name is `{appName}-{NODE_ENV}`, for example `alia-production`. Pass
`dbName` to `mongoose.connect()`; do not embed it in `MONGODB_URI`.

## Oxy service connector

Manifest-driven protocol: apps register tool definitions in MongoDB, Alia
auto-discovers them and exposes them to the AI.

- Service manifests live in the `OxyService` model (tools, events, optional
  context endpoint). `buildOxyServiceTools()` generates AI SDK `tool()`
  wrappers (Zod schemas via `jsonSchemaToZod()`), forwarding the user's own
  OxyHQ JWT — no OAuth for first-party services.
- Events arrive at `POST /webhooks/oxy/:serviceId`, HMAC verified.
- **Adding a service is a data change:** insert an `OxyService` doc, zero Alia
  code changes.
- Tool naming is `oxy_{serviceId}__{toolName}`, e.g. `oxy_inbox__searchEmails`.

Key files: `models/oxy-service.ts`, `lib/tools/oxy-services.ts`
(`buildOxyServiceTools`, `callOxyService`), `routes/oxy-service-events.ts`.

## Connectors (MCP and OAuth): third-party tools for the AI

"Connectors" are **MCP servers** that give the AI tools, surfaced in a
ChatGPT-plugins-style catalog at `/settings/connectors` — the sanctioned
substrate for third-party tools. Do NOT add bespoke per-service tool code; the
old hand-written OAuth "Integrations" were retired, and only Google Calendar
and Drive remain there for lack of a hosted MCP.

- **The MCP client is the official `@modelcontextprotocol/sdk`**, living in
  `packages/integrations` (`src/mcp/manager.ts`), never hand-rolled JSON-RPC.
  `packages/api` never imports the SDK; it proxies over HTTP
  (`INTEGRATIONS_URL` plus `X-Gateway-Secret`).
- **Registry:** one entry in `packages/api/src/lib/mcp-registry.ts` adds a
  connector. Hosted remote OAuth connectors (Notion, GitHub, Linear) set
  `requiresOAuth: true` plus `url`.
- **OAuth is SDK native:** discovery, DCR, PKCE, token use and auto-refresh run
  through an `OAuthClientProvider` (`packages/integrations/src/mcp/oauth-provider.ts`)
  backed by an encrypted Mongo store (`McpConnectorAuth`, tokens
  `select:false`). The per-tool-call hop carries no user token.
- **CSRF-safe by construction, since Alia is cookie-less.** The public
  `GET /mcp/oauth/callback` validates `state` WITHOUT consuming it and hands
  `state` plus `code` to the app; finalization is an AUTHENTICATED
  `POST /mcp/oauth/complete` enforcing `state.oxyUserId === req.userId`.
  **NEVER move linking back into an unauthenticated callback** — that is
  account-linking CSRF. Legacy `integrations-oauth.ts` mirrors the same
  callback-then-complete pattern.
- `POST /mcp/install` is idempotent for registry connectors (duplicate key
  returns the existing row, 200); custom installs still 409.
- **Deploy prerequisite:** `integrations` needs the SAME `TOKEN_ENCRYPTION_KEY`
  as the API (tokens are decrypted across processes) plus `API_BASE_URL`. A
  missing key degrades gracefully — only OAuth-connect calls error.
- The `lib/mcp/` governance layer was deleted as dead code; `buildMcpTools` is
  called directly. Wire any reintroduction into that path, not orphaned.

## Agent bots: an Agent's own Telegram presence

Users register their OWN Telegram bot (a @BotFather token) bound to one of their
Agents, so inbound DMs run that agent's prompt and the owner's real tool
pipeline. This is SEPARATE from the shared system bot (env `TELEGRAM_BOT_TOKEN`,
`/settings/bots` account linking); both coexist in the `Bot` collection.

- `Bot` model: `userId` (owner, absent means system bot), `botToken` (encrypted,
  `select:false`), `webhookSecret` (`select:false`, sparse indexed), `agentId`.
  Registered and managed in the **Agent editor**, not `/settings/bots`.
- **Inbound routing** (`routes/webhooks.ts`): a user bot echoes its per-bot
  secret in `X-Telegram-Bot-Api-Secret-Token`, and matching an active user-owned
  bot IS the verification. Then run the bound agent via `buildChatTools(owner)`,
  bill the owner, and reply with the bot's own token. No match falls through to
  the unchanged global-bot path.
- **CRITICAL invariant:** every "find the system bot" lookup MUST be scoped
  `userId: { $exists: false }` (webhooks, `tools/telegram`,
  `notification-service`, the internal linking routes). User bots share the
  collection, so an unscoped `Bot.findOne({ platform })` could bind a global flow
  to a user bot. `GET /bots` returns the system bots plus the caller's own; the
  system-bots screen filters to `!userId`.
- A per-(bot, end-user) inbound rate limit (15/min, silently dropped) guards
  against a stranger draining the owner's credits. Credits are the hard cap.

## Gateway and provider keys

**There is no gateway service** — `packages/alia-gateway` was deleted. Provider
calls happen in-process in `packages/api/src/internal/providers`.

`packages/api/src/lib/gateway-client.ts` REMAINS and is the seam: it runs the
LOCAL in-process path unless BOTH `SERVICE_SECRET` and `GATEWAY_API_URL` are set,
and production sets only the former. Do not reintroduce a second copy of the
provider logic; a remote provider tier, if ever wanted, goes behind that client.

TTS fails over across providers via `synthesize-speech.ts` and
`internal/providers/lib/tts-providers.ts` (the voice translation table).

Do not construct a second `new WebSocketServer({ server, path })` alongside
socket.io on the same Node `http.Server`. Use `{ noServer: true }` plus one
`server.on('upgrade')` router. Reference: `lib/mcp-relay.ts`.

## UI conventions (packages/app)

- Bloom theming via NativeWind ONLY: surfaces, text and borders use semantic
  classes (`bg-background`, `text-muted-foreground`, `border-border`) mapped in
  `global.css` to Bloom tokens. When a JS color VALUE is unavoidable
  (LinearGradient stops, navigation options, SVG props) use
  `useColorScheme().colors` (`lib/useColorScheme`) and `withAlpha` from
  `@oxyhq/bloom/theme`. Never hex-concat alpha (`color + "08"`), and never use
  the `transparent` keyword as a fade stop toward a surface; fade to
  `withAlpha(surface, 0)`.
- Responsive: pure styling uses NativeWind `md:` classes. JS screen-size checks
  go through `useIsLargeScreen()` (`lib/hooks/use-is-large-screen.ts`, which
  exports `MD_BREAKPOINT`) and ONLY for logic (drawer type, handlers,
  conditionally mounted trees). Never write a raw width comparison.
- Web-only CSS in RN styles (transitions, sticky positioning, cursor) goes
  through the typed `asViewStyle` / `asTextStyle` bridge in
  `lib/types/webStyles.ts`.
- Hover-reveal actions must be web-scoped (`web:opacity-0
  web:group-hover:opacity-100`) so they stay visible on native.
- Sidebar primitives live in `components/sidebar.tsx`: `SidebarRow`,
  `SectionHeader`, `GhostIconButton`. Reuse them rather than inlining duplicate
  row markup. Desktop collapse is a 56px icon rail driven by the `ui-store`
  `sidebarOpen` flag.

## `@alia.onl/sdk` (packages/alia-chat)

Published as RAW SOURCE: consumers' own Metro and tsc compile `src/` directly, so
the package must resolve and typecheck cleanly under a real external install, not
just inside this monorepo.

- **No phantom deps, no hard-imported optional peers.** Anything `src/` imports
  unconditionally (a static `import`, a top-level `export * from`) MUST be a
  regular `dependency` or a REQUIRED peer. An optional peer is not installed by
  consumers, so a hard import only ever "worked" through orphaned entries in a
  consumer's own lockfile and fails Metro resolution on a clean install. Truly
  optional integrations must use lazy `import()` or a guarded `require()`.
  Promoting a peer to required re-hoists consumers' `node_modules` and can
  surface TS2742 (non-portable inferred types) on their exported consts. Fix that
  at the consumer by annotating the export with the package's PUBLIC types, not
  by reverting the peer to optional.
- **Never ship an ambient `declare module` shim for a package that has real
  installed types.** It shadows that package's REAL `.d.ts` program-wide in every
  consumer, not just locally, which can silently break the consumer's own valid
  calls against the real package AND mask a real SDK bug (code compiling against
  an invented export name instead of erroring). Always validate types against the
  real package's own `.d.ts`. The only sanctioned `/// <reference>` is a real
  package's own type augmentation such as `nativewind/types`, never a
  hand-written shim.
- `package.json` carries a `files` allowlist. Keep it: without one, a stray local
  artifact (a `bun pm pack` tarball left in the package dir, for instance) gets
  swept into the published tarball.
