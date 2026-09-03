# PostgreSQL-only runtime and the optional Mongo lock entry

Alia uses PostgreSQL only. No workspace declares `mongodb`, `mongoose` or an
`@mongodb-js/*` package, and runtime source may not import them.

`bun.lock` still resolves `mongodb@7.2.0` because `alia-console` uses Nitro,
Nitro depends on `unstorage@2.0.0-alpha.7`, and unstorage publishes MongoDB as
one of its many optional peer adapters. Removing that one resolution without
replacing or patching Nitro/unstorage requires disabling optional dependencies
for the whole monorepo, which would also change unrelated native/runtime
capabilities. That is not a safe cleanup inside the Kaana cutover.

CI therefore builds the actual `alia-console` Node server and runs
`scripts/check-no-mongodb-runtime.mjs`. The gate fails if any workspace adds a
direct Mongo dependency, runtime source imports a Mongo driver, the console was
not built, or its emitted JS/JSON contains a Mongo import/driver fingerprint.
The lock entry is dependency metadata only; it is not executable Alia runtime.

The route to removing the lock resolution entirely is a separately reviewed
Nitro/unstorage upgrade or replacement whose optional-peer graph no longer
contains MongoDB. Do not paper over it with a hand-edited lockfile or a global
`--omit optional` install.
