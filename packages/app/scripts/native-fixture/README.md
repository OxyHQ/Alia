# Offline native acceptance fixture

This reuses Alia's existing synthetic conversation route under its real root and
app layouts, including the actual SDK composer, thread, providers and stores.
The native entry uses a synchronous router context; ordinary entries still use
the production App. Native Send appends the draft to a local synthetic turn;
Stop cancels that timer. It never performs an inference request.

From `packages/app`, after the normal workspace install:

```sh
EXPO_NO_DOTENV=1 APP_VARIANT=development bunx expo prebuild --platform android --no-install
node scripts/native-fixture/prepare.mjs
EXPO_NO_DOTENV=1 NODE_ENV=production EXPO_PUBLIC_ALIA_FIXTURES=1 \
EXPO_PUBLIC_API_URL=http://127.0.0.1:9 EXPO_PUBLIC_OXY_API_URL=http://127.0.0.1:9 \
ALIA_RN_SOURCE=/path/to/react-native-selection \
node scripts/react-native-source/build.mjs :app:assembleAlia663Lab \
  -PreactNativeArchitectures=arm64-v8a --max-workers=2 \
  '-Dorg.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g'
```

`prepare.mjs` changes generated Android files only and refuses any initial appId
except Alia's development variant. It creates `onl.alia.composer663`, scheme
`alia663`, and an `alia663Lab` variant with release runtime, bundled JavaScript,
no minification, and the debug certificate. The production release signing gate
is preserved. It removes network, microphone, camera and notification permissions
and disables OTA updates. Verify the final merged manifest before installing;
this is an offline app fixture, not a production authentication or service test.

For an unpublished Bloom candidate, use Bloom's `mirror-into-consumer.mjs` with
`--built --into=packages/app` before prebuild. Record its exact source/package
hashes and restore it before any published-package typecheck. Never overwrite
installed package files. The native source-build README records the pinned RN
correction and the paired JavaScript requirement.

Archive APK, merged manifest, bundle/source map, dependency resolution and build
receipt before testing. Keep existing applications and device settings untouched.
After testing, force-stop only this package. Regenerate Android with normal Expo
prebuild to remove generated fixture changes.
