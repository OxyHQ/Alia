# Alia

<p align="center">
  <b>A multi surface context agent platform, built for autonomous execution with policy controls.</b><br>
  One chat runtime behind an app, a VS Code extension, a desktop client, a CLI and an HTTP API.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@alia.onl/sdk"><img alt="@alia.onl/sdk" src="https://img.shields.io/npm/v/@alia.onl/sdk?style=flat-square&label=%40alia.onl%2Fsdk&labelColor=440151&color=D26AE7"></a>
  <a href="https://www.npmjs.com/package/@alia-codea/cli"><img alt="@alia-codea/cli" src="https://img.shields.io/npm/v/@alia-codea/cli?style=flat-square&label=%40alia-codea%2Fcli&labelColor=440151&color=D26AE7"></a>
  <img alt="Bun" src="https://img.shields.io/badge/bun-1.3.14-440151?style=flat-square&logo=bun&logoColor=white">
  <img alt="Expo" src="https://img.shields.io/badge/Expo-57-440151?style=flat-square&logo=expo&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-440151?style=flat-square&logo=typescript&logoColor=white">
</p>

---

<table>
<tr>
<td valign="top" width="50%">

### 🧠 It remembers, and it learns

Context is a persistent graph in MongoDB, not a chat log. `ContextNode`, `ContextEdge`,
`ContextSource`, `RetrievalStrategy` and `LearningRule` are real collections.

The autonomy runtime classifies the intent, recalls context for it, and feeds the result
of the run back in: `classifyIntent`, `recallContextForIntent` and `learnFromRun` in
`packages/api/src/lib/autonomy/`.

</td>
<td valign="top" width="50%">

### 🛡 Risk before action

Every action an agent can take carries a risk level, `R0` through `R3`, decided in
`packages/api/src/lib/agent/governance.ts`.

Reversible writes leave a rollback record, so undoing an autonomous change is a lookup
rather than an investigation.

</td>
</tr>
</table>

> [!IMPORTANT]
> **Public surfaces expose Alia model IDs only.** `alia-lite`, `alia-v1`, `alia-v1-codea`,
> `alia-v1-pro`, `alia-v1-thinking` and `alia-v1-pro-max` are the names anyone outside the
> platform sees. Upstream provider names and provider model IDs never appear in an API
> response, an error, the UI or the docs. The provider adapters live under
> `packages/api/src/internal/`, which is CORS restricted, and user facing errors go
> through a sanitiser first.

## The unified chat runtime

`/alia/chat` and `/v1/chat/completions` are served by the **same handler**, so the app,
Codea and Cowork cannot drift apart in behaviour. Both are registered in
[`packages/api/src/index.ts`](packages/api/src/index.ts).

Around it sit the OpenAI shaped `/v1` routes (`chat-completions`, `models`, `responses`,
`images`, `audio`, `voice`, `shows`) and a provider fallback loop that can retry a request
across adapters.

`/triggers` is the **only** scheduling API. It covers scheduled, webhook, integration and
heartbeat executions. There is no second scheduler and no backward compatible model
resolution endpoint.

## Packages

Thirteen workspaces, not the usual three. Everything lives under `packages/`.

<table>
<tr>
<td valign="top" width="50%">

**Runtime**

| Path | Package | Stack |
|---|---|---|
| [`packages/api`](packages/api/) | `@alia/api` | Express, Mongoose |
| [`packages/alia-gateway`](packages/alia-gateway/) | `@alia/gateway` | Express, Mongoose |
| [`packages/integrations`](packages/integrations/) | `@alia/integrations` | Express, Mongoose |
| [`packages/alia-docker-host`](packages/alia-docker-host/) | `@alia/docker-host` | Express |
| [`packages/shared-types`](packages/shared-types/) | `@alia/shared-types` | TypeScript |

**Surfaces**

| Path | Package | Stack |
|---|---|---|
| [`packages/app`](packages/app/) | `@alia/app` | Expo 57, web and iOS and Android |
| [`packages/alia-codea`](packages/alia-codea/) | `alia-codea` | VS Code extension |
| [`packages/alia-cowork`](packages/alia-cowork/) | `alia-cowork` | Electron, Windows and macOS |
| [`packages/alia-codea-cli`](packages/alia-codea-cli/) | `@alia-codea/cli` | Terminal |

</td>
<td valign="top" width="50%">

**Web**

| Path | Package | Stack |
|---|---|---|
| [`packages/alia-console`](packages/alia-console/) | `alia-console` | TanStack Start, React |
| [`packages/alia-canvas`](packages/alia-canvas/) | `alia-canvas` | Vite, React |
| [`packages/alia-gateway-admin`](packages/alia-gateway-admin/) | `alia-gateway-admin` | Vite, React |

**Shared**

| Path | Package | Stack |
|---|---|---|
| [`packages/alia-chat`](packages/alia-chat/) | `@alia.onl/sdk` | React chat UI, voice, streaming |

Identity comes from the Oxy platform rather than from a login system here:
[`@oxyhq/services`](https://github.com/OxyHQ/oxy) and `@oxyhq/core`, with `@oxyhq/bloom`
for shared UI. See [`docs/oxyhq-auth.md`](docs/oxyhq-auth.md).

</td>
</tr>
</table>

## Quick start

Bun `1.3.14` is pinned in `packageManager`. You also need MongoDB.

```bash
bun install
bun run dev          # every workspace at once
```

More usefully, run only what you are working on:

```bash
bun run dev:api          bun run dev:app
bun run dev:gateway      bun run dev:admin
bun run dev:canvas       bun run dev:integrations
bun run dev:codea        bun run dev:cowork
bun run dev:docker-host  bun run dev:gateway-admin
```

The app has platform shortcuts at the root:

```bash
bun run web    # or ios, or android
```

<details>
<summary><b>Build and start scripts</b></summary>

<br>

`build` and `start` follow the same pattern as `dev`.

| Group | Scripts |
|---|---|
| Build all | `bun run build` |
| Build one | `build:app`, `build:api`, `build:admin`, `build:canvas`, `build:docker-host`, `build:gateway-admin`, `build:integrations`, `build:gateway` |
| Start one | `start:app`, `start:api`, `start:admin`, `start:canvas`, `start:docker-host`, `start:integrations`, `start:gateway` |
| Lint | `bun run lint`, `bun run lint:canvas` |

</details>

> [!WARNING]
> **Bumping an Expo SDK version touches three files, not one.** The root `package.json`
> carries an `overrides` block that pins Expo packages tree wide, and those pins beat
> whatever `packages/app/package.json` declares. That is why `bunx expo install --fix`
> loops forever: the override resets the version it just wrote. A correct bump edits
> `packages/app/package.json`, the root `overrides` block, and `bun.lock`.

## Documentation

<table>
<tr>
<td valign="top" width="50%">

| Doc | Subject |
|---|---|
| [Onboarding](docs/onboarding.md) | **Start here if you are new** |
| [Overview](docs/index.mdx) | What Alia is |
| [Chat runtime](docs/chat-runtime.mdx) | The unified handler |
| [Model abstraction](docs/model-abstraction.mdx) | Alia model IDs and why |
| [API reference](docs/api-reference.md) | The HTTP surface |

</td>
<td valign="top" width="50%">

| Doc | Subject |
|---|---|
| [Agents and autonomy](docs/agents.md) | Execution and policy |
| [Memory and context graph](docs/memory-system.md) | Recall and retrieval |
| [Proactive intelligence](docs/proactive-intelligence.md) | Acting unprompted |
| [Integrations](docs/integrations.mdx) | Channels and messaging |
| [Oxy auth](docs/oxyhq-auth.md) | Identity and sessions |
| [Developer portal](docs/developers-portal.md) | Third party access |
| [Deployment](docs/deployment.md) | Shipping it |

</td>
</tr>
</table>

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Two rules are worth repeating, because both
are easy to break by accident and neither is caught by types:

1. Never expose a provider name or a provider model ID on a public surface.
2. `Triggers` is the only scheduling API. Do not add a second one.
