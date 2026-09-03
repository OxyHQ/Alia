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

Context is a persistent graph, not a chat log. `context_nodes`, `context_edges`,
`context_sources` and `retrieval_strategies` are real PostgreSQL tables
([`packages/api/src/db/schema/context-graph.ts`](packages/api/src/db/schema/context-graph.ts)),
read through `db/autonomy/contextGraphRepository.ts`. Learned rules are `learning_rules`
([`packages/api/src/db/schema/agents-support.ts`](packages/api/src/db/schema/agents-support.ts)),
read through `db/autonomy/learningRuleRepository.ts`.

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
> **The product surface exposes Kaana routing-profile identifiers only.** The public
> `kaana-*` profiles are defined in source; upstream operator names and deployment IDs never appear
> in a product API response, an error, the UI or a customer-facing analytics event, and
> user-facing errors go through a sanitiser first. The rule is a product and privacy
> boundary, not a global ban on the words — engineering docs and ADRs name publishers,
> because [ADR 0003](docs/adr/0003-model-revision-deployment-provider-routing-profile.md)
> makes `<publisher>/<model>` the canonical identifier form for concrete models. Profiles
> are routing policies, not models; see
> [model abstraction](docs/model-abstraction.mdx).

## The chat runtime

`/alia/chat` and `/v1/chat/completions` are served by the **same handler**
(`handleChatCompletions`), so the app, Codea and Cowork cannot drift apart in behaviour.
Both are registered in [`packages/api/src/index.ts`](packages/api/src/index.ts), with
different auth: `optionalAuth` on the first, session-or-API-key plus a per-key rate limit
on the second.

`/alia/chat` is the Alia **product** runtime. The OpenAI-shaped `/v1` routes
(`chat/completions`, `models`, `responses`, `images`, `audio`, `voice`, `shows`) are a
**bounded compatibility surface** that sunsets under
[ADR 0004](docs/adr/0004-product-endpoints-versus-generic-inference-endpoints.md); new
generic integrations go to Oxy Console and `api.oxy.so/v1`.

Hosted inference follows `Alia -> Oxy -> Kaana` through the published
`OxyInferenceClient`. Alia stores no upstream provider credential, constructs no
provider client, signs no Kaana envelope and has no direct-provider fallback.
Kaana owns provider credentials and execution state in its PostgreSQL database.
Oxy resolves identity, policy and the exact ordered deployments; Kaana executes
only that signed order and performs failover only within it.

Alia is present only when the feature is an assistant or agent with conversation
state, memory, tools, approvals or its own bot identity. A bounded product-owned
operation such as translate, classify, summarize, rewrite or smart reply uses
`app -> Oxy -> Kaana` and does not detour through Alia. Sindi and Clarity are the
other case: they are private Alia product agents, so their path is
`product -> Alia agent -> Oxy -> Kaana`.

That is the source target, not a claim that production has already cut over.
Kaana's PostgreSQL/KMS provider-credential custody is merged, but the coordinated
Alia/Oxy/infra rollout and live task-definition gates must still prove that no
old Alia task or provider key remains active. The exclusive canonical Kaana
origin is `https://kaana.ai`; Alia never configures that origin directly.

`/automations` is the normalized scheduling and control API for explicit actors,
resources, actions, data flow and autonomy. `/triggers` remains available for legacy
routines, and both row types use the same elected scheduler rather than competing
runtimes. There is no backward-compatible model resolution endpoint —
`POST /v1/resolve-model` and `POST /v1/report-usage` return `410 Gone`.

## Storage

PostgreSQL through drizzle is the primary store: 80 tables under
[`packages/api/src/db/schema/`](packages/api/src/db/schema/), and the API exits at boot if
it cannot connect. Readiness (`GET /health/ready`) issues a real statement against it.

It is the only store. `@alia/api` opens no MongoDB connection, registers no Mongoose
model and declares no Mongo driver dependency — the last domains (conversations and
messages, agents and their sessions, teams and reviews, organizations, containers,
skills, learning rules, rollback records, canvas sessions and event-stream entries)
landed in PostgreSQL with the port tracked on
[#139](https://github.com/OxyHQ/Alia/issues/139) and merged in
[#465](https://github.com/OxyHQ/Alia/pull/465).
`packages/api/src/db/__tests__/bootWiring.test.ts` walks the real boot graph and the
whole tracked source tree, and fails on any Mongo driver import or direct dependency.

`@alia/integrations` is on PostgreSQL too, under its own schema and its own migration
ledger: the WhatsApp, Telegram and Signal gateways plus the MCP connector OAuth records.
It declares no `mongoose` dependency at all, and
[`packages/integrations/src/db/__tests__/protectedReads.test.ts`](packages/integrations/src/db/__tests__/protectedReads.test.ts)
holds that to zero. Its OAuth secrets are encrypted by the provider rather than by the
column — plain `text` holding `iv:authTag:ciphertext` under the same
`TOKEN_ENCRYPTION_KEY` the API uses — because that is the format they were already
stored in and both processes have to keep agreeing on it.

## Packages

Twelve workspaces across eleven directories — `packages/alia-codea/webview-ui` is its own
workspace entry. Everything lives under `packages/`.

<table>
<tr>
<td valign="top" width="50%">

**Runtime**

| Path | Package | Stack |
|---|---|---|
| [`packages/api`](packages/api/) | `@alia/api` | Express, drizzle + PostgreSQL |
| [`packages/integrations`](packages/integrations/) | `@alia/integrations` | Express, drizzle + PostgreSQL, MCP client |
| [`packages/alia-docker-host`](packages/alia-docker-host/) | `@alia/docker-host` | Express |

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

The bun version is pinned in `packageManager` and CI installs that exact version. You also
need a PostgreSQL instance — the API exits at boot without one. Nothing else is required:
`@alia/api` needs no MongoDB, and Redis is optional.

```bash
bun install
bun run dev          # every workspace at once
```

More usefully, run only what you are working on:

```bash
bun run dev:api          bun run dev:app
bun run dev:admin        bun run dev:canvas
bun run dev:integrations bun run dev:codea
bun run dev:cowork       bun run dev:docker-host
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
| Build one | `build:app`, `build:api`, `build:admin`, `build:canvas`, `build:docker-host`, `build:integrations` |
| Start one | `start:app`, `start:api`, `start:admin`, `start:canvas`, `start:docker-host`, `start:integrations` |
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
| [Chat runtime](docs/chat-runtime.mdx) | The handler, the SSE events, the Kaana boundary |
| [Model abstraction](docs/model-abstraction.mdx) | Product profiles, concrete models and retired alias history |
| [API reference](docs/api-reference.md) | The HTTP surface, by boundary |
| [Architecture decisions](docs/adr/README.md) | The recorded decisions |
| [Compatibility window](docs/migration/compatibility-window.md) | What sunsets, and on what gate |

</td>
<td valign="top" width="50%">

| Doc | Subject |
|---|---|
| [Agents and autonomy](docs/agents.md) | Execution and policy |
| [Memory and context graph](docs/memory-system.md) | Recall and retrieval |
| [Proactive intelligence](docs/proactive-intelligence.md) | Acting unprompted |
| [Integrations](docs/integrations.mdx) | Channels and messaging |
| [Oxy auth](docs/oxyhq-auth.md) | Identity and sessions |
| [Developer access](docs/developers-portal.md) | `alia_sk_*` keys and their sunset |
| [Deployment](docs/deployment.md) | Shipping it |

</td>
</tr>
</table>

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Three rules are worth repeating, because
each is easy to break by accident and none is caught by types:

1. Never expose an upstream operator name or upstream model ID on the **product surface** —
   product API responses, errors, the UI, customer-facing analytics. It is a product and
   privacy boundary, not a global ban on the words.
2. `trigger-engine.ts` is the only scheduler. Legacy triggers and structured automation
   schedules must both register through it; do not add a second scheduling loop.
3. The retired Alia-owned alias set is frozen. A pull request adding one is rejected on
   [ADR 0002](docs/adr/0002-alia-is-a-kaana-consumer-and-future-model-publisher.md), and
   nothing may be published under the reserved `alia/*` namespace without the four
   conditions that ADR lists.
