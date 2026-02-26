# Alia

Alia is an advanced AI agent platform designed to boost productivity through specialized experts.

**Domain:** [alia.onl](https://alia.onl)

## Agents

Four specialized agents are available:

| Agent | Focus |
|-------|-------|
| **Alia** | General-purpose intelligent assistant |
| **Alia Developer** | Software architecture, debugging, development |
| **Alia Social Manager** | Content strategy and social media |
| **Alia Business** | Market analysis and business strategy |

## Monorepo Structure

| App | Stack | Description |
|-----|-------|-------------|
| `apps/app` | Expo | Main Alia app (web + iOS + Android) |
| `apps/api` | Express + TypeScript | API server |
| `apps/alia-codea` | VS Code Extension | AI-assisted coding in VS Code |
| `apps/alia-cowork` | Electron | Desktop AI assistant |
| `apps/alia-console` | TanStack Start + React | Admin console |
| `apps/alia-providers-admin` | Vite + React | Provider management panel |
| `apps/alia-canvas` | Next.js | Web canvas app |
| `apps/alia-codea-cli` | CLI | Terminal AI coding assistant |
| `apps/alia-docker-host` | Express + TypeScript | Docker container host for agent sandboxed execution |
| `apps/integrations` | Express + TypeScript | Unified messaging service (Telegram, Discord, WhatsApp, Signal) |

## Quick Start

```bash
npm install
npm run dev        # All apps in parallel
npm run dev:app    # Main app (Expo)
npm run dev:api    # API server
```

Platform commands for the main app:

```bash
npm run web
npm run android
npm run ios
```

## Documentation

### Technical Docs

- [Alia Agents](docs/agents.md)
- [Developer API Reference](docs/api-reference.md)
- [Production Deployment Guide](docs/deployment.md)
- [Developer Portal](docs/developers-portal.md)
- [Memory System](docs/memory-system.md)
- [Proactive Intelligence](docs/proactive-intelligence.md)
- [OxyHQ Authentication Guide](docs/oxyhq-auth.md)

### App READMEs

- [apps/app](apps/app/README.md)
- [apps/api](apps/api/README.md)
- [apps/alia-codea](apps/alia-codea/README.md)
- [apps/alia-cowork](apps/alia-cowork/README.md)
- [apps/alia-console](apps/alia-console/README.md)
- [apps/alia-providers-admin](apps/alia-providers-admin/README.md)
- [apps/alia-canvas](apps/alia-canvas/README.md)
- [apps/alia-codea-cli](apps/alia-codea-cli/README.md)
- [apps/alia-docker-host](apps/alia-docker-host/README.md)
- [apps/integrations](apps/integrations/README.md)

---

2026 Alia
