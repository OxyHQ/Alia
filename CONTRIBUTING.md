# Contributing to Alia

Alia is a multi surface context agent platform: one chat runtime behind an Expo app, a VS Code extension, a desktop client, a CLI and an HTTP API.

**The contribution process lives in the [Oxy organisation CONTRIBUTING guide](https://github.com/OxyHQ/.github/blob/main/CONTRIBUTING.md)**: reporting an issue, filing a feature request, opening a pull request, code review, licensing. It applies here unchanged. This file layers on top of it the same way `AGENTS.md` files layer, so it is short on purpose: it carries only what is different about this repository.

## Prerequisites

- **Bun.** The package manager for every Oxy repository, never npm or yarn. The pinned version is `packageManager` in the root `package.json`, and CI installs that exact version.
- **Node.js 22.** The runtime the API is built and deployed on. CI pins it alongside bun.
- **MongoDB**, local or remote, to run the API. The test suite does not need one; it starts its own in memory server.
- **Redis**, optional. Caching and rate limiting fall back gracefully without it.

## Setup

```bash
git clone https://github.com/OxyHQ/Alia.git && cd Alia
bun install
cp packages/api/.env.example packages/api/.env   # fill in your values
bun run dev                                      # every package at once
```

You usually want one package rather than all of them:

```bash
bun run dev:api    # API only
bun run dev:app    # Expo app only (runs with --clear --tunnel)
```

Root scripts are named `dev:*`, `build:*` and `start:*`, roughly one per package; read the root `package.json` for the full set. Anything without a shortcut is reachable as `bun run --filter <package> <script>`.

Other packages ship their own `.env.example` (`packages/app`, `packages/alia-gateway`, `packages/alia-gateway-admin`, `packages/alia-cowork`, `packages/alia-docker-host`). Copy the ones for the packages you actually run.

## Layout

A bun workspaces monorepo, no Turborepo and no Nx. Alia is the exception to the Oxy `frontend` + `backend` + `shared-types` baseline: it has thirteen packages, and the API is `packages/api`, not `packages/backend`. The package map is in `AGENTS.md`, so there is one copy of it to keep correct.

Two things worth knowing before your first pull request:

- `packages/alia-chat` publishes to npm as `@alia.onl/sdk`, as **raw source**, so consumers compile `src/` with their own Metro or tsc. It has to resolve and typecheck under a real external install, not only inside this monorepo.
- There is no gateway service. `packages/api/src/lib/gateway-client.ts` runs provider calls in process, and is the seam any future remote provider tier would go behind — do not add a second copy of the provider logic.

## Tests

```bash
bun run --filter @alia/api test
```

Vitest. Place test files next to the source as `*.test.ts`. `packages/api` is the only package with a suite today.

CI runs the following on every pull request, and each line runs locally as written:

```bash
bun run --filter @alia/api lint
bun run --filter @alia/api typecheck
bun run --filter @alia/api test
bun run --filter @alia.onl/sdk typecheck
bun run --filter @alia.onl/sdk check:entries
bun run build:api
```

## Conventions

Coding standards for this repository are in `AGENTS.md` at the repository root, including the model abstraction rule that keeps provider names and provider model ids out of everything user facing, and the Expo SDK override gotcha that makes `bunx expo install --fix` loop forever. `AGENTS.md` is read directly by Claude Code, Codex, Cursor and Copilot, and it is the file to update when a convention changes.
