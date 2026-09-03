# Contributing to Alia

Alia is a multi surface context agent platform: one chat runtime behind an Expo app, a VS Code extension, a desktop client, a CLI and an HTTP API.

**The contribution process lives in the [Oxy organisation CONTRIBUTING guide](https://github.com/OxyHQ/.github/blob/main/CONTRIBUTING.md)**: reporting an issue, filing a feature request, opening a pull request, code review, licensing. It applies here unchanged. This file layers on top of it the same way `AGENTS.md` files layer, so it is short on purpose: it carries only what is different about this repository.

## Prerequisites

- **Bun.** The package manager for every Oxy repository, never npm or yarn. The pinned version is `packageManager` in the root `package.json`, and CI installs that exact version.
- **Node.js 22.** The runtime the API is built and deployed on. CI pins it alongside bun.
- **PostgreSQL**, local or remote. `DATABASE_URL` is the one variable the API cannot start without: it exits at boot if it cannot connect.
- **Redis**, optional. Caching and rate limiting fall back gracefully without it.

`@alia/api` is PostgreSQL-only. It registers no Mongoose model and declares no Mongo
driver dependency. `packages/integrations` is a separate process with its own
PostgreSQL schema and migration ledger; check its own manifest when changing it.

Upstream model credentials are not configured in this repository or its
environment. Kaana stores and administers them in its own database; Alia only
needs the signed Kaana edge configuration documented in
`packages/api/.env.example`.

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

Other packages ship their own `.env.example` (`packages/app`, `packages/alia-cowork`, `packages/alia-docker-host`). Copy the ones for the packages you actually run.

## Layout

A bun workspaces monorepo, no Turborepo and no Nx. Alia is the exception to the Oxy `frontend` + `backend` + `shared-types` baseline: eleven workspaces across ten directories under `packages/` (`packages/alia-codea/webview-ui` is its own workspace entry), and the API is `packages/api`, not `packages/backend`. The package map is in `AGENTS.md`, so there is one copy of it to keep correct.

Three things worth knowing before your first pull request:

- `packages/alia-chat` publishes to npm as `@alia.onl/sdk`, as **raw source**, so consumers compile `src/` with their own Metro or tsc. It has to resolve and typecheck under a real external install, not only inside this monorepo.
- `packages/api/src/lib/gateway-client.ts` is the product seam for signed Kaana
  calls. It must not grow an in-process provider fallback or a second hosted
  inference path.
- Alia is mid-migration. Read [`docs/adr/`](docs/adr/README.md) before a change that touches inference, developer credentials, billing or the model catalogue; [`docs/migration/compatibility-window.md`](docs/migration/compatibility-window.md) says what is frozen and on what gate it is removed. Every pull request against epic [#139](https://github.com/OxyHQ/Alia/issues/139) names its workstream and the exact checkboxes it completes.

## Tests

```bash
bun run --filter @alia/api test        # Default suite; needs no database
bun run --filter @alia/api test:pg     # Postgres-backed suite; needs TEST_DATABASE_URL
bun run --filter @alia/integrations test
```

Vitest. Place test files next to the source as `*.test.ts`. `packages/api` and `packages/integrations` have suites.

The Postgres suites need a real server — CHECK constraints, unique indexes, `ON DELETE CASCADE` and `ON CONFLICT` are enforced by Postgres and have no mocked counterpart. Each run creates and migrates a throwaway database through the real `src/db/migrate.ts` entrypoint, which also exercises its phase and `--target-database` guards.

CI runs the following on every pull request, and each line runs locally as written:

```bash
bun install && git diff --exit-code bun.lock
bun run --filter @alia/api lint
bun run --filter @alia/api typecheck
bun run --filter @alia/api test
bun run --filter @alia.onl/sdk typecheck
bun run --filter @alia.onl/sdk check:entries
bun run build:api
bun run --filter @alia/integrations type-check
bun run --filter @alia/integrations test    # against a real Postgres
bun run --filter @alia/api test:pg          # against a real Postgres
```

CI also runs `.github/scripts/test-deploy-ecs-image.sh`, which gates the rollout logic the AWS deploy uses.

## Conventions

Coding standards for this repository are in `AGENTS.md` at the repository root, including the Expo SDK override gotcha that makes `bunx expo install --fix` loop forever. `AGENTS.md` is read directly by Claude Code, Codex, Cursor and Copilot, and it is the file to update when a convention changes.

Two conventions are worth repeating here because neither is caught by types:

1. **Model identity on the product surface.** Product API responses, product errors, the UI and customer-facing analytics carry `alia-*` identifiers only; user-facing errors go through `sanitizeMessage()`. It is a product and privacy boundary, not a global ban — engineering docs and ADRs name publishers, because ADR 0003 makes `<publisher>/<model>` the canonical identifier form. See [`docs/model-abstraction.mdx`](docs/model-abstraction.mdx).
2. **The `alia-*` set is frozen.** A pull request adding one is rejected on ADR 0002, and nothing may be published under the reserved `alia/*` namespace without the four conditions that ADR lists.
