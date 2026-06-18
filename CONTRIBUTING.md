# Contributing to Alia

## Prerequisites

- **Node.js 22** (use [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm))
- **MongoDB** (local or Atlas)
- **Redis** (optional, falls back gracefully)

## Getting Started

```bash
git clone <repo-url> && cd Alia
bun install              # installs all workspaces
cp apps/api/.env.example apps/api/.env   # fill in your values
bun run dev              # starts all services
```

Focused commands:

```bash
bun run dev:api          # API only
bun run dev:app          # Expo app only
```

## Monorepo Structure

This is an **Bun workspaces** monorepo (no Turborepo/Nx).

| App | Stack | Purpose |
| --- | --- | --- |
| `apps/api` | Express + TypeScript | Core API runtime |
| `apps/app` | Expo 55 (React Native + Web) | Main app (web + iOS + Android) |
| `apps/alia-codea` | VS Code extension | Coding assistant surface |
| `apps/alia-cowork` | Electron | Desktop assistant surface |
| `apps/alia-console` | TanStack Start + React | Admin console |
| `apps/alia-canvas` | Next.js | Canvas app |
| `apps/alia-gateway-admin` | Vite + React | Internal gateway admin |
| `apps/alia-codea-cli` | CLI | Terminal coding assistant |
| `apps/alia-docker-host` | Express + TypeScript | Sandboxed container host |
| `apps/integrations` | Express + TypeScript | Messaging and channel integrations |

## Branch Naming

```
feat/short-description
fix/short-description
refactor/short-description
```

Always branch from `main`.

## Commit Messages

Use [conventional commits](https://www.conventionalcommits.org/):

```
feat: add trigger scheduling UI
fix: correct token refresh race condition
refactor: extract chat handler into shared module
docs: update deployment guide
test: add integration tests for context graph
chore: bump dependencies
```

## Pull Request Process

1. Create a branch from `main` with the naming convention above.
2. Keep PRs focused -- one feature or fix per PR.
3. Write a descriptive PR summary (what changed and why).
4. Ensure CI passes before requesting review.
5. Request review from at least one team member.

## Code Style

- **TypeScript strict mode** encouraged. Avoid `any` -- use proper types.
- **Frontend styling**: NativeWind (Tailwind). No inline style objects unless necessary.
- **State management**: Zustand stores. Data fetching via TanStack Query.
- **Routing**: expo-router (file-based) in `apps/app`.
- Follow existing patterns in the codebase. When in doubt, look at neighboring files.

## Testing

Run API tests before submitting:

```bash
npm test -w @alia/api
```

Tests use **Vitest**. Place test files next to source as `*.test.ts`.

## Key Conventions

### Model Abstraction (Critical)

Alia wraps multiple AI providers behind branded model names. **Never expose provider names or model IDs** (OpenAI, Anthropic, `gpt-4o`, `claude-sonnet-4`, etc.) in:

- UI text, error messages, API responses
- Documentation, comments, or marketing copy

Always use Alia model names: `alia-v1`, `alia-lite`, `alia-v1-pro`, `alia-v1-thinking`, etc.

### Error Handling

Use `sanitizeMessage()` from `apps/api/src/lib/errors/sanitize.ts` for all user-facing error messages. This strips any leaked provider names.

### Database

MongoDB with Mongoose. Database name follows `alia-{NODE_ENV}` convention. Connection URI is shared across the Oxy ecosystem -- the `dbName` is passed to `mongoose.connect()`, not embedded in the URI.
