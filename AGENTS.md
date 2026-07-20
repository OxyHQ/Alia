# Alia — AI Platform

Multi-provider AI platform with 13 packages. Agent: `alia`.

## Deployment

- **Port**: `3001` | **Domain**: `api.alia.onl` | **ECR**: `oxy/alia`
- Build: `linux/arm64` Dockerfile in `packages/api/`.

## Monorepo Structure

Non-standard layout (13 packages, not the three-package baseline):

```
packages/
  app/                Main Expo 57 + NativeWind app (React Native + Web)
  api/                Express backend API
  shared-types/       Shared TypeScript types
  alia-canvas/        Web canvas app
  alia-chat/          Chat package
  alia-codea/         VS Code extension
  alia-codea-cli/     Codea CLI
  alia-console/       Admin console
  alia-cowork/        Collaborative workspace
  alia-docker-host/   Docker host integration
  alia-gateway/       Gateway service (internal)
  alia-gateway-admin/ Gateway admin
  integrations/       Third-party integrations
```

## Expo SDK Override Gotcha

The root `package.json` carries an `overrides` block that pins Expo SDK packages tree-wide (e.g. `"expo": "56.0.11"`, `"expo-font": "56.0.6"`). These pins override whatever `packages/app/package.json` declares — `bunx expo install --fix` loops infinitely because the override resets the version it just wrote.

**Rule:** Any Expo SDK version bump MUST also update the matching entries in the ROOT `package.json` `overrides` block. A correct bump touches THREE files: `packages/app/package.json`, root `package.json` (`overrides`), and `bun.lock`.

## Model Abstraction (CRITICAL)

Users and developers must ONLY see Alia-branded model names. Never expose internal provider names or model IDs.

- **User-facing**: `alia-lite`, `alia-v1`, `alia-v1-codea`, `alia-v1-pro`, `alia-v1-thinking`, `alia-v1-pro-max`
- **Never show**: provider names (OpenAI, Anthropic, Google, Groq, etc.) or provider model IDs in UI, API responses, errors, SEO, or docs
- Use `sanitizeMessage()` from `packages/api/src/lib/errors/sanitize.ts` for all user-facing errors
- Analytics: resolve via `getAliaModel()` and skip entries that can't resolve

Key files:
- `packages/api/src/internal/providers/lib/alia-models.ts` — model definitions
- `packages/api/src/internal/providers/lib/generate-model-mappings.ts` — provider routing
- `packages/api/src/routes/v1/models.ts` — public models API (Alia names only)
- `packages/api/src/lib/errors/sanitize.ts` — strips provider names from errors
- `packages/api/src/internal/` — all provider logic (internal, CORS-restricted)

## MongoDB Database Naming

Database name is `{appName}-{NODE_ENV}` (e.g., `alia-production`). Pass `dbName` to `mongoose.connect()` — do NOT embed it in `MONGODB_URI`.

## Oxy Service Connector

Manifest-driven protocol: apps register tool definitions in MongoDB → Alia auto-discovers and exposes them to the AI.

- **Service manifests** in `OxyService` model: tools, events, optional context endpoint
- **`buildOxyServiceTools()`** generates AI SDK `tool()` wrappers (Zod schemas via `jsonSchemaToZod()`) + forwards user OxyHQ JWT
- **Events** via `POST /webhooks/oxy/:serviceId` (HMAC verified)
- **Adding a service**: insert an `OxyService` doc — zero Alia code changes needed
- Tool naming: `oxy_{serviceId}__{toolName}` (e.g. `oxy_inbox__searchEmails`)
- Auth: forward `req.accessToken` (user's OxyHQ JWT) — no OAuth needed for first-party services

Key files:
- `packages/api/src/models/oxy-service.ts`
- `packages/api/src/lib/tools/oxy-services.ts` (`buildOxyServiceTools`, `callOxyService`, `getOxyServiceContext`, `getOxyServicePromptFragment`)
- `packages/api/src/routes/oxy-service-events.ts`
- `packages/api/src/routes/v1/chat-completions.ts` (~line 615)

## Connectors (MCP + OAuth) — third-party tools for the AI

"Connectors" are **MCP servers** that give the AI tools, surfaced in a ChatGPT-plugins-style catalog at `/settings/connectors`. This is the sanctioned substrate for third-party tools; do NOT add bespoke per-service tool code (the old hand-written OAuth "Integrations" were retired — only Google Calendar/Drive remain there, because they have no hosted MCP).

- **MCP client is the official `@modelcontextprotocol/sdk`**, living in the `packages/integrations` service (`src/mcp/manager.ts`) — NOT hand-rolled JSON-RPC. `packages/api` never imports the SDK; it proxies over HTTP (`INTEGRATIONS_URL` + `X-Gateway-Secret`). Supports stdio / streamable-http / sse.
- **Registry**: `packages/api/src/lib/mcp-registry.ts` — curated connectors. Hosted remote OAuth connectors (Notion `mcp.notion.com`, GitHub, Linear) set `requiresOAuth: true` + `url`; `featured` drives the Featured section. Adding a connector = one registry entry.
- **OAuth is SDK-native**: the SDK owns discovery / Dynamic Client Registration / PKCE / token use / **auto-refresh** via an `OAuthClientProvider` (`packages/integrations/src/mcp/oauth-provider.ts`), backed by an encrypted Mongo store (`oauth-store.ts`, `McpConnectorAuth`, tokens `select:false` + encrypted). The per-tool-call hop carries no user token — the SDK refreshes in-process.
- **OAuth flow is CSRF-safe by construction** (Alia is cookie-less): the public callback `GET /mcp/oauth/callback` does NOT link — it validates the `state` (without consuming) and hands `state`+`code` to the app; finalization is an AUTHENTICATED `POST /mcp/oauth/complete` that enforces `state.oxyUserId === req.userId`. NEVER move linking back into an unauthenticated callback (account-linking CSRF). The legacy `integrations-oauth.ts` uses the identical callback→complete pattern (`int_oauth_state`/`int_oauth_code`). Frontends read those return params and POST complete (see `ConnectorsSection` / `IntegrationsSection`).
- `POST /mcp/install` is **idempotent for registry connectors** (duplicate-key → returns existing 200) so the Connect flow can "ensure installed" before OAuth; custom installs keep 409.
- **Deploy prereqs (oxy-infra):** the `integrations` service env needs `TOKEN_ENCRYPTION_KEY` (same value as the API — encrypted tokens are cross-process) and `API_BASE_URL` (the OAuth callback + per-bot webhook base). Missing `TOKEN_ENCRYPTION_KEY` degrades gracefully (only OAuth-connect calls error).
- The `lib/mcp/` governance layer (McpManager/permissions/health) was deleted as dead code — `buildMcpTools` is called directly; if reintroducing governance, wire it into that path, don't re-add orphaned.

## Agent Bots (multi-bot) — an Agent's own Telegram presence

Users register their OWN Telegram bot (via @BotFather token) bound to one of their Agents, so inbound DMs run that agent's prompt + the owner's real tool pipeline. This is SEPARATE from the shared system bot (env `TELEGRAM_BOT_TOKEN`, `/settings/bots` account-linking) — both coexist in the `Bot` collection.

- `Bot` model: `userId` (owner; absent = system bot), `botToken` (encrypted, `select:false`), `webhookSecret` (`select:false`, sparse-indexed), `agentId`. Registered/managed in the **Agent editor** ("Telegram bot" section), not `/settings/bots`.
- **Inbound routing** (`routes/webhooks.ts`): a user bot echoes its per-bot secret in `X-Telegram-Bot-Api-Secret-Token`; matching an active user-owned bot IS the verification → run the bound agent via `buildChatTools(owner)`, bill the owner, reply with the bot's own token. No match → fall through to the UNCHANGED global-bot path.
- **CRITICAL invariant:** every "find the system bot" lookup MUST be scoped `userId: { $exists: false }` (webhooks, `tools/telegram`, `notification-service`, the internal linking routes) — user bots share the collection, so an unscoped `Bot.findOne({ platform })` could bind a global flow to a user bot. `GET /bots` returns system + the caller's own bots; the system-bots screen filters to `!userId`.
- Per-`(bot, end-user)` inbound rate-limit (15/min, silently dropped) guards against a stranger draining the owner's credits; credits are the hard cap.

## Gateway & provider keys

`alia-gateway` is NOT deployed in production. The API runs the `gateway-client` LOCAL fallback (in-process `internal/providers` + the same MongoDB). HTTP gateway mode requires BOTH `SERVICE_SECRET` and `GATEWAY_API_URL` env vars (explicit opt-in) — see `packages/api/src/lib/gateway-client.ts`.

`packages/alia-gateway/src/lib/provider-api.ts` is a separate duplicate of the API's provider-call logic — changes to provider endpoints (e.g. TTS) must be mirrored there if the gateway is ever enabled.

TTS fails over across providers via `packages/api/src/lib/synthesize-speech.ts` + `packages/api/src/internal/providers/lib/tts-providers.ts` (voice translation table).

## UI conventions (packages/app)

- Bloom theming via NativeWind ONLY: surfaces/text/borders use semantic classes (`bg-background`, `text-muted-foreground`, `border-border`, etc.) mapped in `global.css` to Bloom tokens. When a JS color VALUE is unavoidable (LinearGradient stops, navigation options, SVG props) use `useColorScheme().colors` (`lib/useColorScheme`) and `withAlpha` from `@oxyhq/bloom/theme` — never hex-concat alpha (`color + "08"`), never the `transparent` keyword as a fade stop toward a surface (fade to `withAlpha(surface, 0)`).
- Responsive: pure styling uses NativeWind `md:` classes. JS screen-size checks go through `useIsLargeScreen()` (`lib/hooks/use-is-large-screen.ts`, exports `MD_BREAKPOINT = 768`) and ONLY for logic (drawer type, handlers, conditionally mounted trees) — never raw `width >= 768` comparisons.
- Web-only CSS in RN styles (transitions, sticky positioning, cursor, etc.) goes through the typed `asViewStyle`/`asTextStyle` bridge in `lib/types/webStyles.ts` — never `as any`.
- Hover-reveal actions must be web-scoped (`web:opacity-0 web:group-hover:opacity-100`) so they stay visible on native.
- Sidebar primitives live in `components/sidebar.tsx`: `SidebarRow` / `SectionHeader` / `GhostIconButton` — reuse them, don't inline duplicate row markup. Desktop collapse is a 56px icon rail driven by the `ui-store` `sidebarOpen` flag.

## `@alia.onl/sdk` (packages/alia-chat)

Published as RAW SOURCE — consumers' own Metro/tsc compile `src/` directly, so the package must resolve and typecheck cleanly under a real external install, not just inside this monorepo.

- **No phantom deps, no hard-imported optional peers.** Anything `src/` imports unconditionally (static `import`, top-level `export * from`) MUST be a regular `dependency` or a REQUIRED peer. An optional peer is not installed by consumers, so a hard import only "worked" via orphaned entries in a consumer's own lockfile and fails Metro resolution on a clean consumer install. Truly optional integrations must use lazy `import()` / guarded `require()`. Promoting a peer to required re-hoists consumers' `node_modules` and can surface TS2742 (non-portable inferred types) on their exported consts — fix at the consumer by annotating the export with the package's PUBLIC types, not by reverting the peer to optional.
- **Never ship an ambient `declare module` shim for a package that has real installed types.** It shadows that package's REAL `.d.ts` program-wide in every consumer, not just locally — this can silently break the consumer's own valid calls against the real package AND mask a real SDK bug (code compiling against an invented export name instead of erroring). Always validate types against the real package's own `.d.ts`. The only sanctioned `/// <reference>` is a real package's own type augmentation (e.g. `nativewind/types`) — never a hand-written shim.
- `package.json` carries a `files` allowlist (`["src", "tsconfig.json"]`) — keep it. Without it a stray local artifact (e.g. a `bun pm pack` tarball left in the package dir) can get swept into the published tarball.
