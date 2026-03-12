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
| `apps/app` | Expo | Main app (web + iOS + Android) |
| `apps/api` | Express + TypeScript | Core API runtime |
| `apps/alia-codea` | VS Code extension | Coding assistant surface |
| `apps/alia-cowork` | Electron | Desktop assistant surface |
| `apps/alia-console` | TanStack Start + React | Admin console |
| `apps/alia-canvas` | Next.js | Canvas app |
| `apps/alia-gateway-admin` | Vite + React | Internal gateway admin |
| `apps/alia-codea-cli` | CLI | Terminal coding assistant |
| `apps/alia-docker-host` | Express + TypeScript | Sandboxed container host |
| `apps/integrations` | Express + TypeScript | Messaging and channel integrations |

## Quick Start

```bash
npm install
npm run dev
```

Focused commands:

```bash
npm run dev:api
npm run dev:app
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
