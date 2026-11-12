# Dependency updates

Dependabot checks dependencies weekly and groups `@oxy.so/*` releases into one
reviewable pull request. Regenerate `bun.lock`, then run the normal test and
typecheck gates before merging any proposed update.

`bun run doctor:oxy` is read-only. It verifies that direct Oxy dependencies are
current and that the lockfile has no duplicate Oxy versions; CI never rewrites
the manifest, installs `latest`, or updates dependencies at application startup.

Cowork's browser renderer resolves `react-native` to `react-native-web` in both
esbuild build and watch configurations, with RNW declared in its own dependencies.
Bloom's web font entry can reach shared presentation modules; without this alias,
esbuild parses React Native's Flow entry and fails before tree shaking. Keep this
browser resolution separate from Cowork's Node main and preload builds.
