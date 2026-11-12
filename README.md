# Alia

<p align="center">
  <b>Oxy's assistant: it acts for you in your Oxy apps and works in the background. Your own agents, the gemies, live in <a href="https://gemies.ai">Gemies</a>.</b><br>
  The Alia app (web, iOS, Android), built on <a href="https://www.npmjs.com/package/@gemies/sdk"><code>@gemies/sdk</code></a>.
</p>

<p align="center">
  <img alt="Bun" src="https://img.shields.io/badge/bun-1.4.3-440151?style=flat-square&logo=bun&logoColor=white">
  <img alt="Expo" src="https://img.shields.io/badge/Expo-58-440151?style=flat-square&logo=expo&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-440151?style=flat-square&logo=typescript&logoColor=white">
</p>

---

> [!IMPORTANT]
> **The backend lives in [OxyHQ/Gemies](https://github.com/OxyHQ/Gemies)** since 2026-11-12:
> the API behind `api.gemies.ai`, the integrations service, the agents' computer host, the SDK
> (`@gemies/sdk`) and the server client (`@gemies/server`), their deploys, releases, canaries,
> runbooks and architecture decision records
> ([ADR 0034](https://github.com/OxyHQ/Gemies/blob/main/docs/adr/0034-gemies-and-alia.md)).
> Backend changes go there, not here.

## Packages

One workspace.

| Path | Package | Stack | Purpose |
|---|---|---|---|
| [`packages/app`](packages/app/) | `@alia/app` | Expo 58 | The Alia app: `alia.onl`, iOS and Android |

The conversation, voice and runtime come from [`@gemies/sdk`](https://github.com/OxyHQ/Gemies/tree/main/packages/sdk),
installed from npm. It replaced `@gemies/sdk` and `@gemies/server`, which were published from
here until 2026-11-12 (Gemies ADR 0034 §6).

Identity comes from the Oxy platform rather than from a login system here:
[`@oxy.so/services`](https://github.com/OxyHQ/oxy) and `@oxy.so/core`, with `@oxy.so/bloom`
for shared UI. See [`docs/oxyhq-auth.md`](docs/oxyhq-auth.md).

> [!IMPORTANT]
> **Alia has no models of its own.** A person picks a power level (`auto` … `ultra`) and
> Oxy picks the model. No client names a model: with nothing chosen a request carries no
> `model` and the server's default answers (`scripts/check-model-defaults.mjs`). Model and
> publisher names are shown; the operator serving a deployment and deployment IDs stay off
> the product surface.

## Quick start

The bun version is pinned in `packageManager` and CI installs that exact version.

```bash
bun install
cp packages/app/.env.example packages/app/.env   # EXPO_PUBLIC_API_URL points at the API
bun run dev:app                                  # Expo (web + tunnel)
```

The app has platform shortcuts at the root:

```bash
bun run web    # or ios, or android
```

| Group | Scripts |
|---|---|
| Build | `bun run build:app` |
| Start | `bun run start:app` |
| Lint / format (Biome) | `bun run lint` (check), `bun run lint:fix`, `bun run format` |

> [!WARNING]
> **Bumping an Expo SDK version touches three files, not one.** The root `package.json`
> carries an `overrides` block that pins Expo packages tree wide, and those pins beat
> whatever `packages/app/package.json` declares. That is why `bunx expo install --fix`
> loops forever: the override resets the version it just wrote. A correct bump edits
> `packages/app/package.json`, the root `overrides` block, and `bun.lock`.

## Documentation

| Doc | Subject |
|---|---|
| [Overview](docs/index.mdx) | What lives here, what lives in Gemies, and the reading order |
| [App architecture](docs/app-architecture.mdx) | The feature tree and its import rules |
| [Embedding a gemie](https://github.com/OxyHQ/Gemies/blob/main/docs/agent-embedding.md) | The SDK's wire contract (in OxyHQ/Gemies) |
| [Instant loading](docs/instant-loading.md) | Skeletons instead of spinners |
| [Bloom adoption](docs/bloom-adoption.mdx) | The Alia → Bloom map |
| [Native validation](docs/native-validation.mdx) | Checking the app on a device |
| [Oxy auth](docs/oxyhq-auth.md) | Identity and sessions |
| [Dependency updates](docs/dependencies.md) | Reviewable Oxy updates and Doctor |
| [Gemies docs](https://github.com/OxyHQ/Gemies/blob/main/docs/index.mdx) | The backend: chat runtime, models, voice, agents, API reference, deployment |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Three rules are worth repeating, because
each is easy to break by accident and none is caught by types:

1. Never expose the operator serving a model (Groq, Cerebras, OpenRouter…) or a deployment ID
   on the **product surface** — the UI, errors, customer-facing analytics. Model and
   publisher names are fine.
2. The conversation screen is the SDK's (`GemieChatContent` in `@gemies/sdk`); the app
   supplies only its own chrome through props and slots.
3. No model id in code or environment, and no curated model list.
