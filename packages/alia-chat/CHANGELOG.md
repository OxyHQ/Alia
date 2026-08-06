# @alia.onl/sdk

## 6.0.0

### Licence: this package now has one, and it is Apache-2.0

**Every version up to and including `5.1.0` was published with no `license`
field and no LICENSE file.** Under copyright law that is not permissive by
default, it is all rights reserved: nobody who installed this package had
permission to use, copy or modify it. At roughly ten thousand installs a week,
that was the most consequential thing wrong with this package, and it had
nothing to do with the code.

`6.0.0` is Apache-2.0. It ships a verbatim `LICENSE` and a `NOTICE`, and the
manifest declares `"license": "Apache-2.0"`, so automated policy checks in
consuming companies stop seeing an unlicensed dependency.

This is a pure widening: it grants rights where there were none. Nothing any
existing user is doing becomes non-compliant, and no code, API surface or
behaviour changed in this release.

Apache-2.0 rather than something else because this is a client SDK, the layer
Oxy licenses permissively on purpose: it is a dependency you either can or
cannot add, and one an engineer must be able to add without opening a legal
ticket.

The version is bumped to a major rather than the field being slipped into a
patch. A licence is part of what a package is, and the previous licence changes
in this ecosystem went out inside patch releases, which is how consumers ended
up on terms they never chose. Not repeating that is worth a major.

## 5.1.0

### Changed

- **The `@oxyhq/services` peer range now admits 24.x, 25.x and 26.x**
  (`^23.0.1 || ^24.0.0 || ^25.0.0 || ^26.0.0`). An app on `@oxyhq/services@26`
  previously got `warn: incorrect peer dependency` on every install, which reads
  as a broken integration and is the reason this range is stated rather than
  widened to `>=23.0.1`: each major in the union was audited, and a future one
  will be too before it is added.

  Nothing in this package changed, because nothing needed to. The whole surface
  it consumes from `@oxyhq/services` is one import in four hooks — `useOxy`,
  then `oxyServices.httpService.getAccessToken()` — and every link in that chain
  is byte-identical across services 23.0.1 through 26.0.0 and the `@oxyhq/core`
  13 through 17 those versions pull in. Services 24.0.0 and 25.0.0 were majors
  solely because they raised their own `@oxyhq/core` range; 26.0.0 is the
  RFC 6749 token endpoint, whose `HttpService` changes are confined to
  `URLSearchParams` request encoding and an `error_description` error field.

  This is a compatibility declaration, not a deduplication fix. `@oxyhq/services`
  is a peer dependency here and always has been, so an unsatisfied range emitted
  a warning but never nested a second copy — verified on a clean install.

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
