# Android selection correction source build

The app's RN 0.88.1 matches Expo 58.0.23's `bundledNativeModules.json`.
The published Android binary still normalizes backward selection during an
identical-text layout update on Android 16. The reviewed source correction is
[OxyHQ/react-native#1](https://github.com/OxyHQ/react-native/pull/1).

This opt-in build uses the existing fork, not a patched installation or another
JavaScript React Native package. Ordinary builds still use the published AAR.
It is not yet wired into release CI; do not claim that published Alia contains
the correction. A native change also needs a new app runtime/binary before OTA.

Prepare a separate checkout (outside the application's Metro watch roots):

```sh
git clone https://github.com/OxyHQ/react-native.git /path/to/react-native-selection
git -C /path/to/react-native-selection checkout c76b6d8f34500ab37fd5dc2e0a08c46a03153ce7
cd /path/to/react-native-selection
corepack yarn install --frozen-lockfile
```

Generate Alia's Android project with its normal Expo prebuild first. From
`packages/app`, with Android SDK/NDK and Yarn available on PATH:

```sh
ALIA_RN_SOURCE=/path/to/react-native-selection node scripts/react-native-source/build.mjs \
  :app:dependencyInsight --dependency react-android --configuration releaseRuntimeClasspath
ALIA_RN_SOURCE=/path/to/react-native-selection node scripts/react-native-source/build.mjs \
  :app:assembleDebug -PreactNativeArchitectures=arm64-v8a --max-workers=2 \
  '-Dorg.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g'
```

Debug builds use the normal development certificate. A release build still uses
Alia's existing ecosystem signing gate; this script does not bypass it.

The launcher rejects a dirty or different source commit and mismatched JS/native
versions. Gradle substitutes both current and legacy RN Maven coordinates with
one source project. The included build retains RN's published stable Hermes
260318099.0.5, matching the runtime, rather than building a second engine.
Archive dependency insight, APK hash, source revision and DEX inspection with
every acceptance build. The previous SDK-host evidence is linked from the source
PR; full application build and device acceptance remain pending here.

Remove this opt-in path when an upstream published RN version includes the fix;
upgrade JS and native together and repeat directional selection/composition tests.

## Initial Alia checkpoint (2026-11-08)

- Base app source: cc76a858ff4359254cf51e3f649ea021bfc75ce7.
- RN 0.88.1 / Expo 58.0.23 / React 19.3.0; no other direct dependency changed.
- App typecheck passes; app 1238 tests / 113 files and SDK 937 tests / 125 files pass.
- Expo Android prebuild passes for APP_VARIANT=development.
- Source dependency insight passes: current and legacy RN coordinates resolve to
  the same source ReactAndroid project. Log SHA256:
  6331b441a9869416a4c2a27a789c5fa671e852d383ce8938bdf42cefa54aa303.
- Initial configuration with 512 MB Metaspace failed in Worklets Kotlin script
  compilation; 1 GB passes. This is a local build-resource requirement, not an
  app performance result. Full APK build and physical app acceptance are pending.
