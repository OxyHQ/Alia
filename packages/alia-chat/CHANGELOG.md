# @alia.onl/sdk

## 5.0.0

### Breaking

- **Voice is now an injected capability on `AliaChatScreen` and
  `AliaChatSheet`.** Pass `voiceSession={VoiceSession}` (from
  `@alia.onl/sdk/voice`) to offer voice calls; without it the chat is text-only
  and the microphone button is not rendered.

  ```tsx
  import { AliaChatScreen } from '@alia.onl/sdk';
  import { VoiceSession } from '@alia.onl/sdk/voice';

  <AliaChatScreen voiceSession={VoiceSession} />;
  ```

  `voiceSession` may be a `React.lazy` component — the chat renders it inside
  its own `Suspense` boundary.

  v4.0.0 moved the voice exports out of the root barrel so that text-chat
  consumers would stop compiling `livekit-client`, but `AliaChatContent` still
  imported `useVoiceRoom` and `useAudioLevelMonitor` directly from their
  modules, and `AliaChatScreen`/`AliaChatSheet` reach it. Since this package
  ships raw source, that put the whole LiveKit client (1,204,825 bytes raw,
  ~250 KiB gzip) back into every text-chat consumer's module graph. The split
  could not be made real while the shell owned voice, so it no longer does.

### Added

- `VoiceSession` (`@alia.onl/sdk/voice`) — the LiveKit half of the chat as one
  component. It dials on mount, ends the call on unmount, renders
  `VoiceControls`, and reports room state, agent state, audio amplitude, and the
  transcript back to the chat shell.
- `VoiceSessionComponent`, `VoiceSessionProps`, and `VoiceSessionState` types,
  exported from both entries.

### Fixed

- An unexpected room drop now always ends voice mode. It previously required a
  non-empty pre-call transcript, so a dropped call in a fresh chat left the
  voice UI up with no room behind it.

### Internal

- `bun run --filter @alia.onl/sdk check:entries` walks the real import graph and
  fails if the root entry can reach `livekit-client` (or if the voice entry
  cannot). Wired into CI alongside a new SDK typecheck step.

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
