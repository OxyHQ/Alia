# Alia Developer Onboarding

Last updated: 2026-03-11

Welcome to Alia -- a multi-surface context-agent platform with autonomous execution and policy controls. This guide gets you productive on day 1.

## Architecture Overview

```
                           +-------------------+
                           |   Expo App (Web,   |
    User  ───────────────> |   iOS, Android)    |
                           +--------+----------+
                                    |
                          POST /v1/chat/completions (SSE)
                                    |
                           +--------v----------+
                           |  Express API       |
                           |  (packages/api)        |
                           +--+---------+------+
                              |         |
              +---------------+         +----------------+
              |                                          |
     +--------v--------+                     +-----------v-----------+
     |  MongoDB         |                     |  AI Providers          |
     |  (Mongoose)      |                     |  (routed via Alia      |
     +--------+---------+                     |   model abstraction)   |
              |                               +------------------------+
     +--------v--------+
     |  Redis (Valkey)  |     Socket.IO (real-time events,
     |  rate limits,    |     approval requests, streaming)
     |  caching         |
     +-----------------+
```

### Autonomy Loop

Every chat interaction runs one loop:

1. **classify** -- detect intent (meeting_prep, inbox_digest, research, general, etc.)
2. **recall** -- load ranked context sources and learning rules from the context graph
3. **retrieve** -- gather data from top sources (integrations, MCP servers, Oxy services)
4. **act** -- produce answer, run tools, stream response
5. **learn** -- update source quality scores and persist learned rules

### Risk Governance

| Level | Meaning | Behavior |
|-------|---------|----------|
| R0 | Read-only | Fully autonomous |
| R1 | Reversible write | Autonomous + rollback record saved |
| R2 | External/unknown impact | Requires user approval |
| R3 | Destructive | Blocked |

Approvals are real-time via Socket.IO (`alia.approval_request` / `alia.approval_result`).

---

## Key Directories and Files

### API (`packages/api/src/`)

| Path | What it does | When you touch it |
|------|-------------|-------------------|
| `index.ts` | Express boot: DB connect, route mounting, Socket.IO setup | Adding a new top-level route |
| `routes/v1/chat-completions.ts` | Main chat endpoint -- tool building, AI SDK `streamText`, SSE | Changing chat behavior, adding tools |
| `lib/agent-runner.ts` | Orchestrates autonomous agent sessions | Modifying agent execution flow |
| `lib/autonomy/runtime.ts` | Before/after chat hooks for the autonomy loop | Changing classify/recall/learn steps |
| `lib/tools/index.ts` | Tool barrel file -- exports all tool constructors | Adding a new AI tool |
| `lib/tools/mcp.ts` | MCP server tool builder | MCP integration work |
| `lib/tools/oxy-services.ts` | Oxy Service Connector tool builder | Adding Oxy ecosystem integrations |
| `lib/tools/integrations.ts` | Third-party integration tools (WhatsApp, Telegram, etc.) | Integration work |
| `lib/prompt-loader.ts` | Builds the system prompt from fragments | Changing AI behavior/instructions |
| `lib/chat-core.ts` | Model resolution, `resolveModel()`, `getAIModel()` | Model routing changes |
| `lib/providers-client.ts` | `getAliaModel()`, model mapping lookups | Model abstraction |
| `lib/errors/sanitize.ts` | Strips provider names from error messages | Error handling |
| `lib/redis.ts` | Shared Redis/Valkey client | Caching, rate limiting |
| `lib/db.ts` | MongoDB connection (50-connection pool) | DB config changes |
| `middleware/auth.ts` | JWT verification via OxyHQ, sets `req.userId` | Auth changes |
| `models/` | Mongoose models (~40 files: conversation, message, agent, trigger, etc.) | Schema changes |
| `internal/providers/` | Provider routing logic (CORS-restricted, never exposed) | Internal model config |

### App (`packages/app/`)

| Path | What it does | When you touch it |
|------|-------------|-------------------|
| `app/_layout.tsx` | Root layout: OxyProvider, fonts, theme, auth setup | App-wide providers |
| `app/(app)/_layout.tsx` | Main drawer layout: sidebar, screens, store hydration | Adding a new screen |
| `app/(app)/c/[id]/index` | Chat conversation screen | Chat UI changes |
| `components/chat-interface.tsx` | Core chat UI: messages, input, streaming display | Chat UX changes |
| `lib/stores/` | Zustand stores (18 stores -- see State Management below) | Client state changes |
| `lib/hooks/use-conversations.ts` | TanStack Query hook for conversation CRUD | Conversation data layer |
| `lib/api/client.ts` | API client with auth token injection | API communication |
| `lib/api/routes.ts` | All API route constants | Adding/renaming endpoints |

---

## Data Flow: Chat Message

What happens when a user sends a message:

```
Frontend                            Backend
--------                            -------
1. User types message
2. chat-interface.tsx calls
   POST /v1/chat/completions ──────> 3. Auth middleware (JWT verify)
   with SSE streaming                4. Workspace/org middleware
                                     5. Resolve Alia model -> provider model
                                     6. Load user memory + context graph
                                     7. Build tools: native + MCP + Oxy + integrations
                                     8. Build system prompt (fragments)
                                     9. autonomy beforeChat (classify, recall, retrieve)
                                    10. AI SDK streamText() with fallback chain
                                    11. Stream chunks back via SSE
12. Frontend processes SSE  <──────
    chunks, renders messages
13. Thinking/tool calls
    displayed in real-time
                                    14. autonomy afterChat (learn, score sources)
                                    15. Save conversation + messages to MongoDB
                                    16. Finalize credit usage
```

---

## State Management Patterns

### Zustand Stores (client-side, synchronous)

Use for UI state and data that needs to persist across screens.

| Store | Purpose |
|-------|---------|
| `ui-store` | Right panel, command palette, global UI toggles |
| `model-store` | Selected model, model preferences |
| `theme-store` | Color scheme, app color preset |
| `agents-store` | Agent list, selected agent |
| `projects-store` | Workspace projects |
| `folders-store` | Conversation folders |
| `favorites-store` | Favorited conversations |
| `pinned-store` | Pinned conversations |
| `roles-store` | User-created roles/personas |
| `organization-store` | Org membership, settings |
| `accessories-store` | Avatar accessories |

### TanStack Query (server state, async)

Use for data fetched from the API that needs caching, refetching, and stale management.

- `use-conversations.ts` -- conversation list and CRUD
- API calls go through `lib/api/client.ts` which auto-attaches the OxyHQ JWT

**Rule of thumb**: if the data comes from the server, use TanStack Query. If it is purely UI state or needs synchronous access, use a Zustand store.

---

## Model Abstraction (Critical)

This is the most important convention in the codebase. Violating it is a shipping blocker.

| Layer | What users see | What exists internally |
|-------|---------------|----------------------|
| Public | `alia-lite`, `alia-v1`, `alia-v1-pro`, `alia-v1-thinking`, `alia-v1-pro-max` | Multiple provider models per Alia model |
| Routing | N/A | Cheapest/free provider tried first, then progressively more expensive fallbacks |
| Errors | Generic Alia error messages | `sanitizeMessage()` strips all provider names before returning |

### Rules

- **NEVER** expose provider names (OpenAI, Anthropic, Google, etc.) in UI, API responses, error messages, or docs
- **NEVER** show provider model IDs (gpt-4o, claude-sonnet-4, gemini-2.5-flash) to users
- **ALWAYS** use `sanitizeMessage()` from `lib/errors/sanitize.ts` for user-facing errors
- **ALWAYS** resolve to Alia model names via `getAliaModel()` in analytics/display code

### Key files

- `internal/providers/lib/alia-models.ts` -- Alia model definitions
- `internal/providers/lib/generate-model-mappings.ts` -- provider routing config
- `routes/v1/models.ts` -- public models API (returns only Alia models)
- `lib/errors/sanitize.ts` -- error sanitization

---

## Common Tasks

### Adding a new API route

1. Create `packages/api/src/routes/my-route.ts` with an Express Router
2. Import and mount it in `packages/api/src/index.ts`
3. If it needs auth, the `auth` middleware is already applied to most route groups -- check `index.ts` for the pattern

### Adding a new screen in the app

1. Create a file in `packages/app/app/(app)/` -- expo-router uses file-based routing
2. Register it as a `<Drawer.Screen>` in `app/(app)/_layout.tsx`
3. Add the route constant to `packages/app/lib/api/routes.ts` if it needs an API endpoint

### Adding a new AI tool

1. Create `packages/api/src/lib/tools/my-tool.ts` exporting a tool constructor function
2. Export it from `packages/api/src/lib/tools/index.ts`
3. Wire it into the tool-building section of `routes/v1/chat-completions.ts`
4. Follow the `safeExecute()` pattern used by existing tools for error handling

### Running tests

```bash
npm test -w @alia/api            # Run all API tests
npm test -w @alia/api -- --run   # Run once (no watch)
bun run lint -w @alia/api        # Lint the API
```

---

## Useful Commands

```bash
bun install                      # Install all workspace dependencies
bun run dev                      # Start all apps in dev mode
bun run dev:api                  # API only (Express + hot reload)
bun run dev:app                  # Expo app only (web + tunnel)
npm test -w @alia/api            # API tests (vitest)
bun run lint -w @alia/api        # Lint API code
```

Environment: copy `.env.example` to `.env` in `packages/api/` and fill in your MongoDB URI, Redis URL, and provider API keys. The database name is computed automatically as `alia-{NODE_ENV}` -- do not embed it in the URI.

---

## Links to Deep Docs

| Topic | File |
|-------|------|
| Agents and autonomy loop | [docs/agents.md](agents.md) |
| API reference (all endpoints) | [docs/api-reference.md](api-reference.md) |
| Memory and context graph | [docs/memory-system.md](memory-system.md) |
| OxyHQ authentication | [docs/oxyhq-auth.md](oxyhq-auth.md) |
| Deployment (DigitalOcean) | [docs/deployment.md](deployment.md) |
| Proactive intelligence / triggers | [docs/proactive-intelligence.md](proactive-intelligence.md) |
| Developer portal / API keys | [docs/developers-portal.md](developers-portal.md) |
| Project conventions | [CLAUDE.md](../CLAUDE.md) (also read by AI coding assistants) |
