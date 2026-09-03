# Alia Developer Onboarding

Welcome to Alia -- a multi-surface context-agent platform with autonomous execution and policy controls. This guide gets you productive on day 1.

Read [the ADRs](./adr/README.md) early. `packages/api` is PostgreSQL-only. Hosted
inference follows one boundary: Alia calls Oxy with its service application
credential and Oxy routes the request to Kaana, the only inference data plane.
That service credential is not a provider key. Provider keys exist only as KMS
ciphertext in Kaana's PostgreSQL database; Alia neither loads them nor calls
model providers directly.

## Architecture Overview

```
                           +-------------------+
                           |   Expo App (Web,  |
    User  ───────────────> |   iOS, Android)   |
                           +--------+----------+
                                    |
                          POST /v1/chat/completions (SSE)
                                    |
                           +--------v----------+
                           |  Express API      |
                           |  (packages/api)   |
                           +--+---------+------+
                              |         |
              +---------------+         +----------------+
              |                                          |
     +--------v--------+                     +-----------v-----------+
     |  PostgreSQL     |                     | api.oxy.so            |
     |  (drizzle)      |                     |        |              |
     +--------+--------+                     |        v              |
              |                              | Kaana (kaana.ai)     |
                                             +-----------------------+
     +--------v--------+
     |  Redis (Valkey) |      Socket.IO (real-time events,
     |  rate limits,   |      approval requests, streaming)
     |  caching        |
     +-----------------+
```

PostgreSQL is the hard dependency — the API exits at boot without `DATABASE_URL`. It is also the only one: `packages/api` registers no Mongoose model and opens no MongoDB connection.

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

Approvals are real-time via Socket.IO (`alia.approval_request` / `alia.approval_result`). They are Socket.IO events only — nothing writes them to the chat SSE stream.

---

## Key Directories and Files

### API (`packages/api/src/`)

| Path | What it does | When you touch it |
|------|-------------|-------------------|
| `index.ts` | Express boot: Postgres connect, boot guards, route mounting, Socket.IO setup, background services | Adding a new top-level route |
| `routes/v1/chat-completions.ts` | Main chat handler -- context, tools, hosted stream loop, SSE | Changing chat behavior, adding tools |
| `lib/chat/request-context.ts` | Per-request context: credits, model, memory, entitlements | Changing what a turn loads |
| `lib/chat/provider-loop.ts` | The streaming loop, conversation save, credit finalization | Streaming and persistence |
| `lib/chat/stream-runner.ts` | Chunk handling, tool results, the named SSE writes | SSE event work |
| `lib/agent/runner.ts` | Orchestrates autonomous agent sessions | Modifying agent execution flow |
| `lib/autonomy/runtime.ts` | Before/after chat hooks for the autonomy loop | Changing classify/recall/learn steps |
| `lib/tools/index.ts` | Tool barrel file -- exports all tool constructors | Adding a new AI tool |
| `lib/tool-pipeline.ts` | Assembles the per-request tool set | Adding a new AI tool |
| `lib/tools/mcp.ts` | MCP server tool builder | MCP integration work |
| `lib/tools/oxy-services.ts` | Oxy Service Connector tool builder | Adding Oxy ecosystem integrations |
| `lib/tools/integrations.ts` | Third-party integration tools (WhatsApp, Telegram, etc.) | Integration work |
| `lib/prompt-loader.ts` | Builds the system prompt from fragments | Changing AI behavior/instructions |
| `lib/chat-core.ts` | `resolveModel()`, `getAIModel()` -- builds the AI SDK client | Model routing changes |
| `lib/gateway-client.ts` | Product catalogue and compatibility seam; hosted execution bypasses it for the Oxy inference boundary | Model abstraction |
| `lib/errors/sanitize.ts` | Redacts credentials, endpoints and upstream error codes everywhere; conceals operator identity on the product surface | Error handling |
| `lib/redis.ts` | Shared Redis/Valkey client | Caching, rate limiting |
| `db/index.ts`, `db/schema/` | Postgres connection and the 80-table drizzle schema | Schema changes |
| `db/migrate.ts` | The migrator; requires `--target-database` and honours phase markers | Migrations |
| `middleware/auth.ts` | Token verification via OxyHQ, sets `req.user` | Auth changes |
| `db/*/…Repository.ts` | One repository per domain — chat, agents, billing, automation, autonomy. `models/` holds no model any more; `models/__tests__/retiredModelFiles.ts` is the ledger of the 43 that were deleted | Reads and writes for a domain |
| `domain/` | Closed value sets the drizzle CHECK constraints render from | Adding an enum value |
| `internal/providers/` | Dormant compatibility catalogue and historical migration code; it is not the hosted inference runtime and must not regain provider credentials | Product catalogue compatibility during the retirement window |

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
   POST /v1/chat/completions ──────> 3. Auth middleware sets req.user
   with SSE streaming                4. Workspace/org middleware
                                     5. autonomy beforeChat (classify, recall, retrieve)
                                     6. In parallel: reserve credits, resolve the product
                                        routing profile, load user memory, Oxy profile,
                                        skill, entitlements and agent
                                     7. Build tools: native + MCP + Oxy + integrations
                                     8. Build system prompt (fragments)
                                     9. Stream once through OxyInferenceClient;
                                        Oxy/Kaana own deployment routing and fallback
                                    10. Stream chunks back via SSE
11. Frontend processes SSE  <──────
    chunks, renders messages
12. Thinking/tool calls
    displayed in real-time
                                    13. Save conversation + messages
                                    14. Finalize credit usage
                                    15. afterChat hooks + autonomy learn (non-blocking)
```

Conversations and messages are written to the `conversations` and `messages` tables through `db/chat/conversationRepository.ts` and `db/chat/messageRepository.ts`, both called from `lib/conversation-saver.ts`.

---

## State Management Patterns

### Zustand Stores (client-side, synchronous)

Use for UI state and data that needs to persist across screens.

Sixteen stores in `packages/app/lib/stores/`. The ones you meet first:

| Store | Purpose |
|-------|---------|
| `ui-store` | Right panel, command palette, sidebar collapse, global UI toggles |
| `global-store` | Cross-cutting app state |
| `user-data-store` | The signed-in user's cached product data |
| `model-store` | Selected model, model preferences |
| `agents-store`, `agent-favorites-store` | Agent list, selected agent, favourites |
| `projects-store`, `folders-store` | Workspace projects, conversation folders |
| `favorites-store`, `pinned-store` | Favourited and pinned conversations |
| `roles-store`, `skills-store` | User-created roles/personas, skills |
| `library-store`, `show-store`, `create-collection-store` | Library, shows, collection creation |
| `i18n-store` | Language selection |

### TanStack Query (server state, async)

Use for data fetched from the API that needs caching, refetching, and stale management.

- `use-conversations.ts` -- conversation list and CRUD
- API calls go through `lib/api/client.ts` which auto-attaches the OxyHQ JWT

**Rule of thumb**: if the data comes from the server, use TanStack Query. If it is purely UI state or needs synchronous access, use a Zustand store.

---

## Model Abstraction

The most consequential convention in the codebase, and the one with the most nuance since
the ADRs landed.

| Layer | Today | What it is |
|-------|-------|------------|
| Product surface | Thirteen `alia-*` identifiers | Five in the picker, eight addressable; several are routing policies rather than models |
| Routing | The tier's mapping list, walked in `priority` order | Not price-ordered and not quality-ordered, despite both fields existing |
| Errors | Generic messages | `sanitizeMessage()` redacts credentials, endpoints and upstream error codes, then conceals operator names and model ids |

### The rule, scoped

- **NEVER** put an upstream operator name or upstream model id on the **product surface**:
  product API responses, product errors, the UI, customer-facing analytics.
- **ALWAYS** use `sanitizeMessage()` from `lib/errors/sanitize.ts` for user-facing errors,
  and `redactUnsafeDetail()` from the same module where the text is the CALLER's own and
  concealing it would only make the message unactionable.
- **ALWAYS** resolve display strings via `getRoutingProfile()`, never from the mapping table.
- **DO NOT** add an `alia-*` routing identifier. The retired namespace is frozen under
  [ADR 0002](./adr/0002-alia-is-a-kaana-consumer-and-future-model-publisher.md).

It is a product and privacy boundary, not a global ban on the words. Engineering
documentation, ADRs and schema comments name publishers — ADR 0003 makes
`<publisher>/<model>` the canonical identifier form, so publisher identity becomes part of
the vocabulary.

### Key files

- `internal/providers/lib/routing-profile-catalogue.ts` -- the product-facing Kaana routing profiles
- `internal/providers/lib/generate-model-mappings.ts` -- compatibility inputs for the product catalogue
- `lib/inference/oxy-inference.ts` -- the fail-closed published Oxy SDK boundary
- `routes/v1/models.ts` -- the public catalogue
- `lib/errors/sanitize.ts` -- the two sanitisation rules, and which surfaces each covers

[Model abstraction](./model-abstraction.mdx) has the full table, and the compatibility
window that retires it.

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
3. Register it in `lib/tool-pipeline.ts`, which assembles the per-request tool set
4. Follow the `safeExecute()` pattern used by existing tools for error handling

### Adding an enum value

Closed value sets live in `packages/api/src/domain/`, not in a schema file, because the
drizzle CHECK constraints render from those exact tuples. Add the value there, run
`bun run --filter @alia/api db:generate`, and commit the generated migration with the
change.

---

## Useful Commands

Bun only. There is no npm or yarn in this repository.

```bash
bun install                              # Install all workspace dependencies
bun run dev                              # Start all packages in dev mode
bun run dev:api                          # API only (Express + hot reload)
bun run dev:app                          # Expo app only (web + tunnel)
bun run --filter @alia/api lint          # Lint the API
bun run --filter @alia/api typecheck     # Typecheck the API
bun run --filter @alia/api test          # API tests (vitest; needs no database)
bun run --filter @alia/api test:pg       # API tests against a real Postgres
bun run --filter @alia/api db:generate   # Generate a migration from the schema
```

`test:pg` and the integrations suite need a real PostgreSQL and read `TEST_DATABASE_URL`;
each run creates and migrates its own throwaway database.

Environment: copy `.env.example` to `.env` in `packages/api/` and fill it in.
`DATABASE_URL` is the only database variable and the API refuses to boot without
it. Alia declares no Mongo driver dependency. Hosted provider credentials live
exclusively in Kaana's PostgreSQL database; Alia reaches inference through Oxy
with an Oxy application service credential and never receives a provider key.

---

## Links to Deep Docs

| Topic | File |
|-------|------|
| Architecture decisions | [docs/adr/README.md](adr/README.md) |
| What sunsets, and on what gate | [docs/migration/compatibility-window.md](migration/compatibility-window.md) |
| Chat runtime, SSE events, the Kaana boundary | [docs/chat-runtime.mdx](chat-runtime.mdx) |
| What the `alia-*` identifiers really are | [docs/model-abstraction.mdx](model-abstraction.mdx) |
| Agents and autonomy loop | [docs/agents.md](agents.md) |
| API reference, by boundary | [docs/api-reference.md](api-reference.md) |
| Memory and context graph | [docs/memory-system.md](memory-system.md) |
| OxyHQ authentication | [docs/oxyhq-auth.md](oxyhq-auth.md) |
| Deployment (AWS ECS Fargate) | [docs/deployment.md](deployment.md) |
| Proactive intelligence / triggers | [docs/proactive-intelligence.md](proactive-intelligence.md) |
| Developer access and `alia_sk_*` keys | [docs/developers-portal.md](developers-portal.md) |
| Contributing | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Project conventions | [AGENTS.md](../AGENTS.md) (also read by AI coding assistants) |
