# @alia.onl/sdk

## 4.1.0

### Changed

- Every `lucide-react-native` import is now a per-icon subpath
  (`lucide-react-native/icons/<name>`) instead of the package barrel, and the
  dependency moved from `^0.562.0` to `^1.24.0` (the first line that exposes
  `./icons/*` in its `exports` map, with per-icon type declarations).

  The barrel statically re-exports ~1750 icon modules and Metro does not
  tree-shake, so a single named import pulled roughly 1.2 MB of unused icon
  source into every consumer bundle. Measured with a real Metro build of the
  same eight icons: 1755 modules / 1 656 869 bytes via the barrel versus
  16 modules / 18 312 bytes via subpaths.

- **Consumers must enable Metro's package-exports resolution.** Set
  `resolver.unstable_enablePackageExports = true` in `metro.config.js`. It is
  the default in Expo SDK 53+ and Metro 0.82+, so most projects already have
  it. Without it the bundle fails at build time with
  `Unable to resolve module lucide-react-native/icons/…` — a loud failure, not
  a silent runtime one.

The public API is unchanged: no icon is re-exported from `.` or `./voice`, and
no exported component, hook, or type was added, removed, or renamed.

## 4.0.1

- Expose `./package.json` in the `exports` map.

## 4.0.0

### Breaking

- The voice surface moved from the root entry to `@alia.onl/sdk/voice` so
  text-chat consumers no longer pull `livekit-client` through the export
  barrel. Update imports of `AudioWaveVisualizer`, `VoiceOverlay`,
  `VoiceControls`, `useVoiceRoom`, `useAudioLevelMonitor`, `useAudioLevels`,
  `useAmbientWave`, `useSoundEffects`, `useVoiceSoundEffects`, and the
  `RoomState` / `AgentState` / `VoiceMessage` / `VoiceToolInvocation` types.

  Note that rendering `AliaChatScreen` or `AliaChatSheet` still reaches
  `livekit-client`: `AliaChatContent` imports `useVoiceRoom` and
  `useAudioLevelMonitor` directly. Only consumers composing the leaf
  primitives themselves avoid it.
- An `exports` map was introduced, so deep imports into package internals no
  longer resolve. Only `.`, `./voice`, and `./package.json` are public.
