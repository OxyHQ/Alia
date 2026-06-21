# Alia

Alia is a multi-surface context-agent platform focused on autonomous execution with policy controls.

## Current Architecture (2026-03)

- **Unified chat runtime** for app, Codea, and Cowork (`/alia/chat` and `/v1/chat/completions` share one handler).
- **Autonomy loop**: `classify -> recall -> retrieve -> act -> learn`.
- **Persistent context graph** in MongoDB (`ContextNode`, `ContextEdge`, `ContextSource`, `RetrievalStrategy`, `LearningRule`).
- **Risk governance** with `R0/R1/R2/R3` and rollback records for reversible writes.
- **Trigger engine only** (`/triggers`) for scheduled, webhook, integration, and heartbeat executions.
- **Strict model abstraction**: public APIs only expose Alia model IDs.

## Monorepo

| App | Stack | Purpose |
| --- | --- | --- |
| `packages/app` | Expo | Main app (web + iOS + Android) |
| `packages/api` | Express + TypeScript | Core API runtime |
| `packages/alia-codea` | VS Code extension | Coding assistant surface |
| `packages/alia-cowork` | Electron | Desktop assistant surface |
| `packages/alia-console` | TanStack Start + React | Admin console |
| `packages/alia-canvas` | Next.js | Canvas app |
| `packages/alia-gateway-admin` | Vite + React | Internal gateway admin |
| `packages/alia-codea-cli` | CLI | Terminal coding assistant |
| `packages/alia-docker-host` | Express + TypeScript | Sandboxed container host |
| `packages/integrations` | Express + TypeScript | Messaging and channel integrations |

## Quick Start

```bash
bun install
bun run dev
```

Focused commands:

```bash
bun run dev:api
bun run dev:app
```

## Docs

- [Onboarding guide](docs/onboarding.md) — **start here if you're new**
- [Contributing](CONTRIBUTING.md)
- [Agents and autonomy](docs/agents.md)
- [API reference](docs/api-reference.md)
- [Deployment](docs/deployment.md)
- [Proactive intelligence](docs/proactive-intelligence.md)
- [Memory and context graph](docs/memory-system.md)
- [Oxy auth](docs/oxyhq-auth.md)
- [Developer portal](docs/developers-portal.md)

## Non-Goals

- `Triggers` are the only scheduling API.
- No public model provider metadata.
- No backward-compat model-resolution endpoints.
