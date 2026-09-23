# PostgreSQL-only runtime

Alia uses PostgreSQL only. No workspace declares `mongodb`, `mongoose` or an
`@mongodb-js/*` package, runtime source may not import them, and `bun.lock`
resolves none of them.

`bun.lock` used to resolve `mongodb@7.2.0` because the retired `alia-console`
used Nitro, Nitro depends on `unstorage`, and unstorage publishes MongoDB as one
of its optional peer adapters. CI therefore built that console and searched its
server artefact for a driver. The console was deleted in the clean cut of the
`alia_sk_*` developer platform, and the lock resolution went with it.

`scripts/check-no-mongodb-runtime.mjs` fails if any workspace adds a direct
Mongo dependency, runtime source imports a Mongo driver, or `bun.lock` resolves
a Mongo package, directly or transitively.
`.github/scripts/test-check-no-mongodb-runtime.mjs` proves each of those can
still fail.
