# Contributing to Alia

This repository is the Alia app (Expo: web, iOS and Android) and the two packages published from it, `@gemies/sdk` and `@gemies/server`. **The backend — the API, the integrations service and the agents' computer host — lives in [OxyHQ/Gemies](https://github.com/OxyHQ/Gemies)**; a backend change is a pull request there.

**The contribution process lives in the [Oxy organisation CONTRIBUTING guide](https://github.com/OxyHQ/.github/blob/main/CONTRIBUTING.md)**: reporting an issue, filing a feature request, opening a pull request, code review, licensing. It applies here unchanged. This file layers on top of it the same way `AGENTS.md` files layer, so it is short on purpose: it carries only what is different about this repository.

## Prerequisites

- **Bun.** The package manager for every Oxy repository, never npm or yarn. The pinned version is `packageManager` in the root `package.json`, and CI installs that exact version.
- **Node.js 22**, which CI pins alongside bun for the scripts under `scripts/` and `.github/scripts/`.

No database and no provider credential: the app talks to the API at `EXPO_PUBLIC_API_URL`.

## Setup

```bash
git clone https://github.com/OxyHQ/Alia.git && cd Alia
bun install
cp packages/app/.env.example packages/app/.env   # fill in your values
bun run dev:app                                  # Expo app (runs with --clear --tunnel)
```

Root scripts are named `dev:*`, `build:*` and `start:*`; read the root `package.json` for the full set. Anything without a shortcut is reachable as `bun run --filter <package> <script>`.

## Layout

A bun workspaces monorepo with one workspace, `packages/app`. The backend, `@gemies/sdk` and `@gemies/server` live in OxyHQ/Gemies; the app installs `@gemies/sdk` from npm, so an SDK change is a Gemies pull request and a version bump here.

## Tests

CI runs the following on every pull request, and each line runs locally as written:

```bash
bun install --frozen-lockfile
bunx biome ci .                                   # Biome: format check + lint, whole repo
node scripts/check-ts-directives.mjs
bun .github/scripts/typecheck-workspaces.ts       # every workspace's typecheck (the app's included)
bun run --filter @alia/app test
node scripts/check-model-defaults.mjs
node scripts/check-retired-vocabulary.mjs
```

Vitest everywhere. `ci.yml` has the full list, including the gates that prove each check can still fail.

## Conventions

Coding standards for this repository are in `AGENTS.md` at the repository root. `AGENTS.md` is read directly by Claude Code, Codex, Cursor and Copilot, and it is the file to update when a convention changes.

Two conventions are worth repeating here because neither is caught by types:

1. **Model identity on the product surface.** The UI, product errors and customer-facing analytics never name the operator serving a model or a deployment ID. Model and publisher names are fine.
2. **No client names a model.** With nothing chosen a request carries no `model` and the server's default answers; `scripts/check-model-defaults.mjs` walks every client tree for a hardcoded one.
