# @alia.onl/sdk

## Unreleased

### `AliaMarkdown` builds its parser once

`react-native-markdown-display` evaluates its `markdownit`,
`allowedImageHandlers` and `topLevelMaxExceededItem` defaults on every render,
so each render of each block built a Markdown parser and rebuilt its renderer
and styles. `AliaMarkdown` now passes one shared parser and those defaults'
own values, created once. Output is unchanged; a 1,000-message thread holds
7 MiB less heap in the app.

### Voice errors have codes

Additive. `useSpeechToText` returns `errorCode` beside `error`, and
`useVoiceRoom` returns `errorCode` and `turnErrorCode` beside `error` and
`turnError`: a `VoiceErrorCode` (exported from both entries with
`VOICE_ERROR_MESSAGES`, the English copy) so an app can say what went wrong in
its own language. The English strings are unchanged.

`VoiceControls` takes `labels` (defaults in `VOICE_CONTROLS_LABELS`) for every
word it shows, and its mute and end buttons are named buttons for screen
readers, mute as a toggle.

`useSpeechToText` unmounted mid-dictation now also clears `useSTTStore`. It used
to abort the recognizer but leave the store reading `isRecording: true`, which
`useAmbientWave` then drew as dictation for as long as the page lived.

## 9.0.0

### The full-screen chat clears the gesture bar and the keyboard

`AliaChatScreen` padded only the top safe-area inset, so on edge-to-edge
Android its composer sat under the gesture bar (OxyHQ/Mention#1140). It now pads
the bottom inset too, and wraps the chat in a keyboard-avoiding view that
measures its own position in the window (keyboard-controller's
`automaticOffset`): the composer rises onto the keyboard, and because that view
already ends above the inset, the inset is not added on top of the keyboard. The
avoiding view `PromptInput` carries measured its parent-relative layout and so
never lifted inside the screen. The web `KeyboardAvoidingView` accepts and
ignores `automaticOffset`. Also released for 7.x as 7.2.9.

### Real models, and no model identifier in the package

Alia has no models of its own: `GET /catalogue` now lists the real models Oxy
serves (`publisher/model`), with the server's `defaultModelId` and
`featuredIds`. The SDK follows it, and the product modes and routing profiles
(`mode:*`, `route:*`) are gone from it.

**Breaking:**

- `PREFERRED_CHAT_MODEL_ID` and `PREFERRED_VOICE_MODEL_ID` are removed. With no
  `model`, `useAliaChat`, the voice turn sender, `useTTS` and `useVoiceRoom` send
  no `model` and the server's default (chat or speech) answers.
- `parseCatalogue` and `fetchCatalogue` return a `Catalogue`
  (`{ entries, defaultModelId, featuredIds }`), and `CatalogueEntry` is the new
  model shape (`name`, `publisher`, `contextWindow`, `reasoningEfforts`,
  `pricing`, …). `CatalogueEntryKind` is removed.
- `resolveSelection(requestedId, catalogue)` and `resolveModelId(apiUrl,
  requestedId?)` take no preferred id; an identifier the catalogue no longer
  lists resolves to `undefined` (omit `model`) instead of a substitute.
- The `alia.model_switch` stream event is no longer accepted; the server no
  longer sends it.

**Added:** `AliaMarkdown` takes `renderCodeBlock` to draw fenced code with the
host's own code card (the Alia app passes Bloom's `CodeBlock`).

### The consumer-backend path is documented

Documentation only; no code, wire or default changed, and no version is cut for
it.

The package now has a README. It says which endpoint `useAliaChat` calls and
why it is `/v1/chat/completions` rather than `/alia/chat`: this package ships
raw source and compiles into apps on origins Alia does not enumerate, and
`/alia/chat` answers CORS preflights only for Alia's own origins. It then
documents the path that works from any origin today — `useAliaChat({ apiUrl })`
pointed at the consumer's own backend, which calls `POST /alia/chat`
server-to-server, forwards the user's Oxy token, and streams the SSE body back
unchanged — with a minimal relay. The `apiUrl` option's JSDoc says the same in
short. Issue #244 records the two other shapes and why neither is available
yet.

## 8.0.0

### Voice runs on the device

Dictation and voice calls work again. Both used Alia endpoints that called
speech providers directly — `POST /v1/voice/transcribe` and a LiveKit room from
`POST /v1/voice/token` — and both have been refusing since Alia's inference
moved behind Oxy, which serves chat and speech synthesis but no transcription or
realtime session. Those endpoints are removed from the API.

- **`useSpeechToText`** recognizes on the device (Web Speech API on web,
  `expo-speech-recognition` on iOS/Android). Its shape is unchanged —
  `startRecording`, `stopAndTranscribe`, `cancel`, the three states,
  `useSTTStore` metering — and it gains `lang` and `isSupported`.
- **`useVoiceRoom`** is a turn loop: on-device listening with end-of-utterance
  detection, each utterance sent through the chat path (`sendTurn`, by default
  `createAliaVoiceTurnSender`, which posts `/v1/chat/completions` with
  `responseMode: 'voice'`), the answer spoken sentence by sentence through
  `/v1/audio/speech`, and barge-in. `connect`, `disconnect`, `roomState`,
  `agentState`, `messages`, `isMuted`, `toggleMute` and `error` keep their
  meaning; it adds `turnError` and the options `sendTurn`, `chatModel`, `lang`,
  `endOfUtteranceMs` and `bargeIn`.
- The call asks `/v1/audio/speech` for the product voices `male` / `female`;
  it no longer sends upstream voice names.

**Breaking:**

- `livekit-client` is no longer a peer dependency; `expo-speech-recognition`
  is a new one (the root entry's dictation reaches it on native), and a native
  app needs a new build with its config plugin.
- `useVoiceRoom().room` is a `VoiceLevelSource` (live capture and playback
  levels), not a LiveKit `Room`; `useAudioLevelMonitor` takes that.
- `livekit-client` is gone from the package entirely; nothing in either entry
  reaches it (`check:entries` asserts that).
- The cohost is removed. `useVoiceRoom` no longer returns `cohostActive`,
  `roundComplete`, `enableCohost`, `disableCohost` or `continueCohost`, and
  `currentSpeaker` is `'primary' | 'user' | null`. `VoiceControls` no longer
  takes `cohostActive`, `currentSpeaker`, `roundComplete`, `onEnableCohost`,
  `onDisableCohost` or `onContinueCohost`, and draws no cohost button or
  "Continue conversation" prompt. `ChatMessage.speaker` and
  `VoiceMessage.speaker` are `'primary'` only, and the message list draws no
  "Cohost" label.
- `useSpeechToText` no longer takes `apiUrl` or `accessToken`; dictation never
  talks to the Alia API. Pass `lang` or nothing.
- The pre-Bloom composer is no longer public. `PromptInput`,
  `PromptInputTextarea`, `PromptInputActions`, `PromptInputSubmitButton`,
  `PromptInputMicButton`, `PromptInputAddMenu`, `PromptInputAttachments`,
  `PromptInputAutocomplete`, `PromptInputContext`, `usePromptInput`,
  `useIsFullscreen`, `ChatTextInput` and the types `PromptInputProps`,
  `PromptInputContextType`, `Attachment` and `Completion` are removed from the
  root entry. `AliaChatScreen` / `AliaChatSheet` still draw their composer;
  build your own from the primitives if you composed one from these parts.
- Dependencies trimmed: `@tanstack/react-query`,
  `@tanstack/react-query-persist-client` and
  `@tanstack/query-async-storage-persister` are no longer dependencies (no
  module imported them), and `socket.io-client` and `expo-font` are no longer
  peer dependencies (likewise unused). Keep them in your app if your app uses
  them itself.

**Server side, alongside this release:** the `alia_sk_*` developer keys are
retired and refused by the Alia API. The SDK never used them — it sends the
signed-in user's Oxy session — but a backend that relays the SDK's requests
with such a key must forward the user's Oxy token instead (see the README).

## 7.2.8

### One Oxy runtime and a native-only notifications boundary

The Alia app now consumes the canonical `@oxy.so/*` packages throughout, so
the provider and SDK hooks resolve the same Services context. Its notification
setup also loads `expo-notifications` only after confirming a native platform;
web no longer evaluates Expo's unsupported device push-token listener.

## 7.2.7

### Compatible Oxy 1.0 peers

The SDK now accepts the current `@oxy.so/core` and `@oxy.so/services` 1.x patch
line from 1.0.1 onward. Applications therefore share one canonical Oxy runtime
instead of installing duplicate 1.0.0 peer copies.

## 7.1.1

### A stream either answers or fails

Text chat now uses the linked Oxy client, so the session manager performs its
preflight refresh and its one supported 401 retry. The SDK no longer copies a
bearer token into a raw `fetch` call.

The response must be SSE and must satisfy the Alia/OpenAI stream contract: valid
UTF-8 and JSON, typed product events, a finish chunk, a visible assistant answer,
and terminal `[DONE]`. A malformed, truncated, empty or error stream is a failed
turn and receives the existing visible retry message instead of becoming an
empty successful assistant bubble.

Active text requests are cancelled when their component unmounts, when a sheet
starts closing, when the user stops the turn, or when another send supersedes
it. Parser failures cancel the response reader as well. The parser bounds total
bytes, buffered frame size and line count so a broken stream cannot grow memory
without limit.

The 7.1.0 sampled-audio behavior and the root/voice entry split are unchanged.

## 7.1.0

### The read-aloud field answers the audio

`useTTS` drove the ambient field from a four-keyframe loop keyed on "is it
playing?" — the same animation for every clip, and for silence. It now reads the
player's own samples through `setAudioSamplingEnabled`, and both sources of the
field, dictation and playback, share one curve: `levelFromDbfs` in
`src/lib/audio-level.ts`, the logarithmic -60 dBFS floor dictation already used.
A linear reading of the same audio puts a normal speaking voice near the bottom
of the range, which is why the two looked nothing alike.

Nothing in the public surface changed shape: the hook keeps its signature and
its return type. What changed is what the field does while a message plays.

## 7.0.0

### `AliaMark` is now `IdentityMark`

**Breaking, and a rename with no alias behind it.** `AliaMark`,
`AliaMarkProps` and `AliaMarkState` are gone; the exports are `IdentityMark`,
`IdentityMarkProps` and `IdentityMarkState`. The artwork, the animation states,
the props and the defaults are unchanged, so upgrading is the rename and
nothing else.

The old name said the mark belonged to Alia. It does not: the same component
draws every AGENT in Alia too, differing only in the colour it is handed, and
an agent's Oxy account carries no avatar image at all — so this is the whole of
an agent's likeness. A second component had been copied out of this one for
that job, with the artwork duplicated and a tinted disc behind it. Two
components drawing one thing is how they drift, and the disc was never wanted.
Both are now this one, and where a face would otherwise go it is the SIZE that
adapts, never a background.

### The mark is only a button when you give it `onPress`

Without `onPress` it renders as a plain view rather than a `Pressable`. It had
always mounted one, to carry a spin-and-haptics flourish on tap, and a
`Pressable` captures the touch whether or not the caller wanted a control —
which is what stops a row it sits inside from opening when you tap the face on
it. Passing `onPress` keeps the flourish exactly as before.

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

- **The `@oxy.so/services` peer range now admits 24.x, 25.x and 26.x**
  (`^23.0.1 || ^24.0.0 || ^25.0.0 || ^26.0.0`). An app on `@oxy.so/services@26`
  previously got `warn: incorrect peer dependency` on every install, which reads
  as a broken integration and is the reason this range is stated rather than
  widened to `>=23.0.1`: each major in the union was audited, and a future one
  will be too before it is added.

  Nothing in this package changed, because nothing needed to. The whole surface
  it consumes from `@oxy.so/services` is one import in four hooks — `useOxy`,
  then `oxyServices.httpService.getAccessToken()` — and every link in that chain
  is byte-identical across services 23.0.1 through 26.0.0 and the `@oxy.so/core`
  13 through 17 those versions pull in. Services 24.0.0 and 25.0.0 were majors
  solely because they raised their own `@oxy.so/core` range; 26.0.0 is the
  RFC 6749 token endpoint, whose `HttpService` changes are confined to
  `URLSearchParams` request encoding and an `error_description` error field.

  This is a compatibility declaration, not a deduplication fix. `@oxy.so/services`
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
