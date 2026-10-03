# Alia: final SDK manifest preparation

Base `d9847676849a74b1956934f2033f2421caf0b62b`; own worktree `/home/nate/Oxy/Alia/.worktrees/1519-final-sdk-pins-20261003`.

This is a reviewed-input preparation artifact, **not an installed or published
SDK adoption**. The real package manifests and `bun.lock` remain unchanged.
`manifest-update.patch` is a concrete pending diff with 21 version
changes; `git apply --check` passes against this base. Keeping it as a patch avoids
committing manifests that cannot yet be resolved with their matching registry lock.

Targets: contracts 4.9.0, core 4.2.0, Services 11.1.0, MCP 1.1.0 and protocol 1.2.2
where already directly declared. No unused direct dependency is added. Bloom
consumers pin exactly 6.2.1; an existing Bloom peer is constrained to
`>=6.2.1 <6.3.0`. Final package/lock resolution must also verify transitive minima.

This base is the accepted I10 head d9847676. Integration owns additional uncommitted I05 runtime source in its separate worktree; that source is NOT included here and must arrive as a reviewed commit before final composition. Existing SDK peer ranges already allow core 4.2 and Services 11.1 and are preserved; no unrelated public peer compatibility was removed.

The read-only Bloom import census finds 192 imported subpaths, all
with export entries and existing target files in published 6.2.1. This checks
paths only: named exports, props, rendering and full application compatibility
remain unverified until the actual installation/build. No source API replacement
or automatic downgrade workaround is included.

## Remaining sequence

1. Receive root's final package publication/integrity receipts and any outstanding
   accepted application source commits. Recheck input hashes and conflicts.
2. Apply `manifest-update.patch`, then run
   `bun install --minimum-release-age=0`. Preserve resulting `bun.lock` in the same
   source commit as the manifests. Never hand-edit lock entries or silently resolve
   an old version under the final nominal version.
3. Read installed package versions and compare registry tarball integrity/files;
   assert one intended Oxy/Bloom graph. Candidate packs are a separate test input.
4. Execute the package checks below with an owned PostgreSQL fixture where needed;
   existing database tests must remain real. Scope fixtures to their own IDs and
   preserve cleanup. Read package test selectors before invoking the final focal.
5. Check frontend auth preserves origin actor and active account, ordinary login,
   explicit logout/cold boot and callback contract. Backend MCP must preserve
   resource/account checks, revocation and idempotency.
6. Review source/lock/proof and coordinate CI and deployment with root. This document
   authorizes no independent live operation and closes no global acceptance item.

Planned commands (not executed by this preparation):

```sh
bun run --filter @alia/api typecheck
bun run --filter @alia/app typecheck
bun run --filter @alia.onl/sdk typecheck
bun run --filter @alia/api test
bun run --filter @alia/app test
bun run --filter @alia.onl/sdk test
```

The JSON plan records original manifest and lock hashes. The source diff outside
this audit directory is empty. No existing frozen native fixture or peer agent
worktree was edited.
