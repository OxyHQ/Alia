# @alia.onl/sdk

## 18.1.0

- **`AliaAvatarIcon` is her still until she moves.** At icon size it drew Alia through the live 3D
  runtime, so a header button cost every cold load of the app around it the whole runtime from
  alia.onl (measured: 31 requests, 16.1 MiB in headless Chromium; Mention's home header). It is now
  Bloom's `Avatar` with her character and a still made ahead of time (`characterStill`, Bloom
  10.9.0), a 16 KB PNG in the source: nothing of the runtime loads until she thinks or works, when
  she goes live and plays her working turn as before, with the still under her until the first
  frame. Reduced motion keeps her a still. `bun run render:avatar-still` redraws the still with the
  installed Bloom's runtime; a test fails if `ALIA_AVATAR` changes without it. Peer
  `@oxy.so/bloom` is `>=10.9.0`.

## 17.0.2

- **The composer has its loader again.** While a turn runs, the pill is wrapped in Bloom's
  `ComposerLoader` (the light that laps its rim) with `surface={false}` and `frosted`, as the
  composer had before it became `ComposerPill` (15.1.0) and lost it. A question Alia asks sits
  beside the loader instead of inside the pill's `question` slot, so the light does not ring it.

## 18.0.0

One thread, one conversation screen. The Alia app's thread — its turns, cards, work log, thought
panel, history, search and scroll window — moves into the SDK, and `AliaChatContent` becomes the
whole conversation: the bottom sheet, `AliaChatScreen` and the app are frames around it. What the
app keeps is what is its own: the sidebar, the right panel, the column layout that mounts them,
its routes and its callbacks.

- **Breaking: the sheet and the screen draw the app's thread.** `AliaChatMessageList` and
  `ThinkingBlock` are gone, with the avatar-identity reply they drew. The turns are Bloom's AI Chat
  turns (`AliaThread`, `ThreadRow`), with copy, like/dislike, read aloud, regenerate, edit, the
  long-press menu, day lines, tool cards, the "Worked for…" line and the failed turn's toast with
  Retry. `renderMarkdown`, `onEditMessage`, `onThumbsUp`, `onThumbsDown`, `onApprovePlan` and
  `onRejectPlan` are removed from `AliaChatContent`: the thread edits in the composer, votes through
  the API (`PATCH /v1/conversations/:id/messages/:id/vote`) and answers plans itself.
- **Breaking: `AliaChatContent`'s `header` is `chrome`.** `chrome(state)` returns
  `{ header, title, project, actions }`, the whole of what the container draws around the thread
  (the breadcrumb included). `AliaChatState.clear` is `startOver`; it also carries `conversationId`,
  `clearMessages`, `openSearch` and `getMessages`. `AliaVoiceOptions` loses `isFocused` (the chat
  has one, for the ambient field too) and gains `sounds`.
- **New: what a host brings to `AliaChatContent`.** `threadHandle` (an agent's permanent thread:
  history above, search, jump), `ephemeral` (ghost mode), `model` + `onModelChange` +
  `deviceModels` (the power-level selector: the seven levels from `buildPowerLevelOptions`, then
  the person's own devices), `addMenu` (the host's rows; photos by default), `composerStatus`,
  `surface`, `layout`, `isFocused`, `bottomInset` (now gives way to the keyboard,
  `KeyboardSafeAreaFloor`), `onSignInRequired`, `renderUsageLimit`, `onSuggestionPicked`.
  `AliaSuggestion.template` marks a line with blanks to fill.
- **New: where the work of a turn is read.** `ThoughtPanel` draws the selection of
  `useThoughtStore` (`open`, `setTab`, `sync`, `close`); the host places it. `AliaRuntimeHost`
  gains `showThought(opening)` (return `false` to decline an automatic opening), `openAutomation`
  (a scheduled-task card is a link only where the host says where it goes) and `faviconUrl`.
  `AliaChatSheet` opens it in a sheet over the conversation. `FilesAndSources` takes
  `outputActions` (`canOpen`/`open`): asking whether a file opens no longer opens it.
- **New: the weather, market and FairCoin cards are the SDK's.** Their tools are in the pipeline
  every Alia surface calls and the numbers travel in the message, so any surface that draws Alia's
  reply draws them.
- **New: `AliaRuntimeProvider speech`** (`voice`, `tone`, `language`) for read-aloud, dictation and
  calls; `useTTS` takes its `apiUrl` and preferences from it.
- **New: the thread's data layer, in `@alia.onl/sdk/runtime`.** `useThreadHistory`,
  `useThreadSearch`, `useThreadWindow`, `useAgentActivity` (and `applyActivityEvent` /
  `hydrateActivity` in `/model`), `useThoughtStore`, `aliaQueryKeys.threads`,
  `AliaApi.patch`, `ConversationThread`, `AgentRun` (`useConversationThread` now
  returns `agentRun`), and `useConversation(undefined)`. The agent routes are Alia's own clients'
  (outside `/v1`).
- **New: `@alia.onl/sdk/model`** also carries the power levels (`POWER_LEVELS`,
  `resolveModeSelection`…) and `triggerLabel` / `cronLabel`.
- **Changed: `AliaChatScreen`'s ambient field takes the whole screen's shape** (`layout="screen"`, the default); the sheet keeps its smaller one (`layout="sheet"`).
- **Changed: `labels.locale`** (the language `labels.t` speaks, for dates, days and prices). The
  chat's English covers every key the thread asks for (`tests/lib/copy-keys.test.ts` reads the
  source and fails on one it lacks).
- **Changed: `AliaMarkdown` defaults its body face to Bloom's** (`MARKDOWN_BODY` is gone), and
  `ReplyMarkdown` — rich blocks, references list, code card — is the reply's renderer.
- **New peers:** `expo-web-browser`, `react-native-css`; `expo-clipboard` is no longer optional.
- **Fixed:** the thought panel asked "can this file open?" by opening it, once per output, while
  rendering.

## 17.1.0

- **New leaf entry `@alia.onl/sdk/avatar`.** `AliaAvatarIcon`, `AliaAvatar`, `ALIA_AVATAR` and
  `useAliaActivity` without the chat: an app draws Alia's live avatar on a header button and keeps
  the conversation UI behind a lazy import, instead of putting the whole SDK in its entry bundle.
  `check:entries` holds the leaf free of the sheet, the composer, the markdown renderer and the
  voice call. The root entry still exports the same four.

## 17.0.1

- The task labels follow the API's tool loader: `loadTools` ("Loading tools" / "Loaded tools")
  replaces `useApps`, which the API no longer has. A conversation stored with `useApps` calls
  still replays; the call just shows its raw name.

## 17.0.0

One conversation runtime. The sheet, `AliaChatScreen` and the Alia app are frames around the
same data layer and the same conversation screen: conversations are persisted, listed, opened,
renamed, deleted and cleared through the same hooks, a turn is the same stream, and a
conversation started in one surface is the same conversation in the others. The runtime is the
app's, moved and generalised (`src/runtime`).

- **Breaking: the sheet and the screen have conversations.** Turns are stored, and the SDK
  speaks only to `/v1` (`POST /v1/chat/completions`, `/v1/conversations`): bearer, no cookies,
  public CORS, so it works from every Oxy app's web origin with no backend in between. The API
  gained `/v1/conversations` (the same router as `/conversations`, behind a person's session
  only) for this. The consumer-backend relay the README used to document is no longer needed.
- **Breaking: `useAliaChat`, `UseAliaChatOptions`, `UseAliaChatReturn`, `AliaChatStreamError`,
  `AliaChatFailure` are removed.** Use `useConversationThread`.
- **Breaking: the `agents` prop is gone** from the sheet, the screen and `AliaChatContent`
  (the pre-opened agent message of a delegation is the thread's agent run now).
- **Breaking: `model`** is sent as given (a power level — `auto`, `instant`, `medium`, `high`,
  `xhigh`, `pro`, `ultra` — or an exact `publisher/model`) instead of being checked against
  `GET /catalogue` first. The catalogue helpers (`fetchCatalogue`, `parseCatalogue`,
  `resolveSelection`, `resolveModelId`, `clearCatalogueCache` and their types) are removed: the
  SDK itself no longer reads the catalogue, and people choose power levels, not model names.
- **Changed: the header's Clear starts a new conversation** in the sheet and the screen (the
  thread empties and the next turn opens a fresh conversation); nothing is deleted, the old one
  stays in the list. Deleting or emptying a stored conversation is `useDeleteConversation` /
  `useClearConversation`.
- **Breaking: `ChatMessage` is the runtime `Message`:** `createdAt` is an ISO string, and a
  `ToolInvocation` always has a `toolCallId`. Agent answers use the server's ids
  (`<reply id>-agent-<n>`).
- **Breaking: voice.** `openElsewhere` and `owner` are gone from `useVoiceLauncher` and
  `AliaVoiceOptions`; `conversationId` and `agentId` belong to the chat. A call always lives in a
  conversation: the open one, or — on a new-chat screen — one created when the call starts (after
  the gate) and shown, and it opens on the screen that shows that conversation — in place in the
  sheet, on the destination route in a navigating host (`useVoiceCallRequests`). `start()` is
  async. New options `resolveConversation` and `accountId`; a live call now ends when the screen
  shows another conversation, loses focus or changes account.
- **Who owns the open conversation:** a host that navigates (`runtime.openConversation`, or one
  from an outer `AliaRuntimeProvider`) decides; with none, `AliaChatContent` keeps its own.
- **Breaking: `labels.workLog` is `labels.t`, and `englishWorkLog` is `englishCopy`.** One translator
  keyed like the Alia app's catalogue asks for every string that is not a fixed `labels` field
  (the work log, the thread, the thought panel…); the app hands its own `t` in, a host without one
  reads English (`src/lib/copy-en.ts`).
- **Breaking: `ChatMessage` is `Message`** (and `ToolInvocation` always has a `toolCallId`).
- **New leaf entries.** `@alia.onl/sdk/model` is the conversation as pure data — the records and
  what a list of messages becomes before anything draws it (`timelinePositions`, `buildSteps`,
  `extractSources`, `cardOf`, `daySeparators`, `buildConversationMarkdown`…), no React, no Oxy
  client. `@alia.onl/sdk/runtime` is the data layer (hooks, cache, stores) and re-exports the model.
  `check:entries` holds both leaves free of the UI and the call.
- **New peer: `@tanstack/react-query`** (the runtime's cache; `OxyProvider` already mounts it).
- **New:** `AliaRuntimeProvider` / `useAliaRuntime` (`apiUrl`, `chatUrl`, `offline`, `streamFetch`,
  and `host: AliaRuntimeHost`: navigation, `onUsage`, `onArtifact`, `onToolResult`, `onContext`,
  `onAgentTurn`, `onTurnPreview`, `turnRequest`, `deviceInfo`, `subscribeConversationMessages`),
  `useConversations`, `useConversation`, `usePrefetchConversation`, `useCreateConversation`,
  `useRenameConversation`, `useDeleteConversation`, `useClearConversation`, `useSaveConversation`,
  `useConversationThread`, `useTurnEdit`, `useComposerDraftStore` (+ `useComposerDraft`,
  `useDraftAddress`), `useConversationStore`, `aliaQueryKeys`, `useAliaApi`, `AliaApiError`,
  `buildMessageContent`, `UsageLimitError`, `FailedTurn`; `AliaChatContent` takes
  `conversationId`, `onConversationChange`, `agentId` and `runtime`.
- **New labels:** `newChat`, `sendFailed`, `signInRequired`, `conversationSaveFailed`,
  `conversationDeleteFailed`, `conversationCreateFailed`, `conversationClearFailed`,
  `attachmentNotSent`, `attachmentUnreadable`.
- The composer's text and photos are the shared per-conversation draft (they survive closing the
  sheet and failed sends restore them).

## 16.0.0

Voice is part of the conversation screen. The sheet, `AliaChatScreen` and the Alia app now run
the same call, with the same words and the same behaviour, instead of each orchestrating it.

- **Breaking: the `voiceSession` prop is gone** from `AliaChatContent`, `AliaChatScreen` and
  `AliaChatSheet`, together with the `VoiceSessionComponent` type. Voice is on by default; pass
  `voice={false}` for a text-only chat. `voice={{ ... }}` (`AliaVoiceOptions`) brings the host's
  part: `canStartVoice` (answers `'sign-in' | 'plan-required' | 'credits-exhausted' | null`;
  the SDK tells the person, `onVoiceBlocked` adds navigation or sign-in), `onCallEnded` (refresh
  credits and the thread), `onNotice` (default: Bloom's toast), `conversationId`, `agentId`,
  `locale`, `voice` (`'male' | 'female'`), `onMessagesSaved`, `owner` and `isFocused` (a live
  call ends when the screen is no longer on show or the account/conversation changes) and
  `openElsewhere` (a screen with no conversation to hold the call opens one and hands over).
- **Breaking: `VoiceSessionProps.onEnd` takes no argument.** `VoiceSession` itself says why a
  call failed (`labels.voiceError(code)`), that it ended without failing
  (`labels.voiceEnded(reason)`: moved to another device, time limit, silence, credits, server
  shutdown; a hang-up says nothing) and, once, that it is about to end
  (`labels.voiceEndingSoon`, also shown in the bar), through `onNotice`. New `onMessagesSaved`
  and `onNotice` props.
- **Breaking: labels.** `voiceFailed` is replaced by `voiceControls`, `voiceEnded`,
  `voiceEndingSoon` and `voiceBlocked`. `AliaChatLabelsProvider` and `useLabels` are exported.
- **New:** `useVoiceLauncher` (the host side of a call: gate, state, ownership), `AliaVoiceCall`
  (the call bar, loaded on its first use), `toastNotice`, `VoiceNotice`, `VoiceBlockReason`.
- **Breaking: `react-native-audio-api` is a required peer** (it was optional): the conversation
  screen includes the call. It is still only evaluated on the first call (one lazy `import()`),
  and `check:entries` now holds that, not the old isolation.

## 15.3.0

- **The composer is Bloom's `ComposerPill`.** `AliaComposer` (the sheet's, the screen's and the
  Alia app's one composer) was built on `ComposerPanel` in 13.2.0, which changed the sheet's
  look. It is the pill again — the compact composer the sheet always had — carrying everything the
  app needed from the panel: the power-level picker (`modes` → the pill's `permissions`), the
  docked questions and the status tab. Requires `@oxy.so/bloom` >= 10.6.0, where the pill takes
  them. No prop of `AliaComposer` changes.
- The 13.1.1 note under 13.2.0 below (the avatar flights load the runtime) shipped in 13.2.0.

## 15.2.1

- **The shipped source compiles under `noUnusedLocals`.** The package ships its `.tsx` source, so a
  consumer's own `tsc` (an app with `noUnusedLocals`/`noUnusedParameters`, such as the Oxy website)
  type-checks it and failed on eight unused imports in `AliaChatMessageList` (`Pressable` and the
  reanimated worklet helpers, left behind by the work-log move). They are gone, and the SDK's
  tsconfig now turns the two flags on so it cannot regress.

## 15.2.0

- **`AliaChatSheetRef.present(turn?)`.** Given a turn (`{ text, images? }`), the conversation opens
  over the sheet with that message already sent: the "ask Alia about this" button of a profile, a
  post or a file (the way X opens a conversation with Grok about a post). Without a turn nothing
  changes. `AliaTurn` is exported.

## 15.0.0

A voice call is a realtime speech-to-speech session through Alia and Kaana, and the composer's
microphone is transcribed by a Kaana model (Alia ADR 0017). Nothing is recognized by the browser
or the operating system any more, anywhere in the SDK.

- **Breaking: `useVoiceRoom` is a call over Alia's `GET /v1/voice/session` WebSocket.** It sends
  the microphone as PCM16 24 kHz frames and plays the answer's PCM16 frames; turn detection and
  barge-in are the model's, on the server, and tools, memory and the stored transcript are Alia's.
  New options: `conversationId` (where the transcript is stored; omitted, each call starts a
  conversation of its own), `agentId`, `voicePreference`, `lang`, `onMessagesSaved` (refresh the
  thread), `onApprovalRequested`, and the test seams `createAudioEngine` / `openSocket`. Gone:
  `sendTurn`, `chatModel`, `model`, `endOfUtteranceMs`, `bargeIn`, `synthesisError`, `turnError`,
  `turnErrorCode`, `warning`, `warningCode`.
- **Honest states.** `callState` (`VoiceCallState`) is `connecting` → `listening` (only once the
  session is ready upstream, the microphone delivered a buffer AND Alia acknowledged the first
  appended audio) → `user-speaking` → `thinking` → `using-tool` → `speaking` (only when the first
  answer frame is PLAYING) → … → `ended { reason }` or `error { code }`, plus `reconnecting`
  while a dropped socket resumes within the session's resume window or Alia re-opens the session
  upstream. `roomState` (now with `reconnecting`) and `agentState` are its coarse projections;
  `endedReason` says why a call ended — `call-moved-elsewhere` (the person opened a call
  elsewhere) is a reason, not an error. `endingSoonMs`, `model` (the serving model's name; never
  the operator) are new.
- **Barge-in:** when the server hears the person start speaking, the playback queue is flushed and
  Alia is told how many milliseconds of the answer were actually heard, so the model remembers
  what was said, not what it generated.
- **The audio engine** (`createVoiceAudioEngine`, `VoiceAudioEngine`): web is `getUserMedia` with
  echo cancellation, noise suppression and gain control plus two `AudioWorklet`s (capture to
  24 kHz PCM16, jitter-buffered playback) in one `AudioContext` — Firefox gets calls. iOS and
  Android use **`react-native-audio-api`** (new optional peer, `^0.13.6`), capture and playback in
  one native stack; iOS runs `playAndRecord` in mode `voiceChat` (voice processing). **A host app
  needs a new native build** with the library's config plugin. On Android the library exposes no
  `voiceCommunication` input preset yet, so platform echo cancellation is a gate to measure on
  device (ADR 0017 §4).
- **Breaking: `useSpeechToText` and `useSTTStore` are replaced by `useDictation` and
  `useDictationStore`.** Dictation records a clip (`MediaRecorder` on web, Opus/WebM or MP4 on
  Safari; the `expo-audio` recorder on iOS/Android, m4a sent as `audio/mp4`) and transcribes it with
  `POST /v1/audio/transcriptions` when the person stops. States: `idle`, `requesting-permission`,
  `recording` (only once the recorder started; levels are the recorder's), `transcribing`,
  `error`. The text arrives through `onText`, never partially; a failed transcription keeps the
  clip for one `retry()`. Clips stop by themselves at five minutes, and `remainingMs` counts the
  last 30 s. `requestTranscription` and `DictationError` are exported. Dictation works in Firefox
  now.
- **`AliaComposer`** dictates with `useDictation`: the transcription is appended to the draft the
  person has when it arrives, a failure is said with a Retry that re-sends the same clip, and the
  time left shows over the composer in the last 30 s. New prop `apiUrl`; new label
  `dictationRemaining`.
- **Breaking: `VoiceErrorCode` is rewritten.** The recognizer's codes (`speech-*`,
  `microphone-*`, `recognizer-*`, `no-audio-input`, `turn-failed`, `no-answer`, `not-played`,
  `synthesis-*`) are gone. It is now Alia's call codes (`not-authenticated`,
  `credential-not-supported`, `plan-required`, `credits-exhausted`, `agent-unavailable`,
  `invalid-request`, `resume-unavailable`, `realtime-unavailable`, `realtime-limited`,
  `realtime-rejected`, `realtime-failed`), the device's (`mic-denied`, `mic-unavailable`,
  `connection-lost`, `voice-unavailable`) and dictation's (`too-long`,
  `transcription-unavailable`, `transcription-limited`, `transcription-rejected`,
  `transcription-failed`). An app with its own translations replaces its keys.
- **Removed:** `createAliaVoiceTurnSender` and the `VoiceTurn*` types, the device recognizers
  (`speech-recognition*`, `chooseSpeechRecognizer`), `isInterruption` and the rest of
  `voice-text`, and the **`expo-speech-recognition` peer** — a host app removes it and its config
  plugin. Read-aloud (`useTTS`, `/v1/audio/speech`) is unchanged.
- `VoiceSession` takes `conversationId`, `agentId`, `locale` and `voice`; `VoiceControls` takes
  `callState` and shows `reconnecting` and `usingTool` (new labels).
- The `./voice` entry still holds the call: `scripts/check-entry-isolation.mjs` now also proves the
  root entry never reaches `react-native-audio-api` (nor `expo-speech-recognition`).

## 14.1.0

An "Ask Alia" button can show her live avatar and react to what she is doing.

- **`AliaAvatarIcon`**: a Bloom icon component (`icon={AliaAvatarIcon}`) that draws the live avatar
  at the icon size under its own `AgentAvatarProvider` on `ALIA_CHARACTER_RUNTIME_URL`, not interactive.
- **`useAliaActivity()`** returns `'idle' | 'thinking' | 'working' | 'writing'`, the busiest of the
  turns running in this app (`useAliaChat` now publishes its lifecycle to a shared store) and the
  server's `alia:activity` events for the signed-in person (one shared `socket.io-client` connection
  per API origin, none while signed out, closed with the last consumer). New dependency:
  `socket.io-client`. Needs the API that emits `alia:activity` (an older API simply never sends it:
  buttons then follow local turns only).
- The header mark and the buttons read a turn from one function (`turnActivityState`).

## 14.0.0

Read-aloud asks the server every time, and the server answers a clip it already made from storage:
a message read aloud twice, or a sentence voice mode says again, is synthesized and paid for once.

- **Breaking: `useTTS().readAloud(messageId, text, conversationId?)`** loses its fourth argument,
  `audioUrl`. A message no longer carries a stored clip of its own: `POST /v1/audio/speech` finds
  the clip by its text, voice, speed and speech model, for the signed-in person, and answers a
  stored one at once. There is no "play the stored link, remake it if it has gone" path any more.
- **Breaking: `ChatMessage.audioUrl` is removed.** `GET /conversations/:id` no longer sends it.
- `requestSpeechClip`'s `conversationId` + `messageId` now file the clip under that conversation,
  so deleting or clearing the conversation deletes it. The route still answers 404 for a message
  the person does not hold, and `requestId` is present only when the clip was made by that request.

A voice call says "Listening…" only while something listens.

- **`useVoiceRoom` stays `connecting` until the recognizer has started** (`roomState` is
  `'connected'` and `agentState` `'listening'` from the first session's start, not from
  `connect()`), and a session that does not start within 8 s ends the call as
  `recognizer-not-started`.
- **An `aborted` nobody asked for is a failure.** Chrome runs one microphone recognition per
  browser and a new one aborts the live one, in any tab; the engines now report that as the
  failure code `interrupted` (only the abort the caller asked for stays silent), and a call cut
  off three times in a row ends as `recognizer-aborted` instead of restarting forever. The web
  engine serializes its own sessions, so a page never aborts itself.
- **The call watches itself while it listens:** voice-level sound for 5 s with no word back ends
  it as `recognizer-unresponsive`; five sessions in a row that end without listening end it with
  their error's code; a microphone silent for 10 s raises **`warning` / `warningCode`**
  (`no-audio-input`) without ending the call. Recognizer errors are logged as a structured
  `console.warn`, never with the transcript.
- **`VoiceErrorCode` gains** `recognizer-not-started`, `recognizer-unresponsive`,
  `recognizer-aborted` and `no-audio-input` (an app with its own translations adds them);
  `VoiceControls` takes a `notice` it shows in place of "Listening…". Dictation reports an
  interrupted session as `recognizer-aborted` too.

## 13.1.1

- **The avatar flights load the runtime too.** 13.1.0 mounted the character runtime provider inside
  the chat, but the sheet's avatar-flight layer (the avatar that flies from the welcome into the
  header) is drawn outside it, so it asked the host for its own `/bloom-character/runtime.mjs` and got
  the app's HTML back ("Expected a JavaScript-or-Wasm module script but the server responded with
  a MIME type of text/html"). `AliaChatSheet` and `AliaChatScreen` now wrap everything they draw in the
  provider, once; `AliaChatContent` no longer mounts one (it is not an entry point on its own).

## 13.2.0

One composer for the sheet, the screen and the Alia app: the app's composer moved here and the
app consumes it.

- **`AliaComposer`** (exported) is Bloom's `ComposerPanel` plus what every Alia surface needs the
  same way: files by paste and drop (read with real progress, retried, refused with a sentence),
  dictation, the suggestions over the field and the questions Alia asked, docked above it. What
  differs per surface is a prop: `addMenu` / `onAddMenuSelect`, `modes` / `mode` /
  `onModeChange` (a power-level selector), `attachments` / `onAddAttachment` /
  `onRemoveAttachment` (a composer given no `onAddAttachment` takes no paste or drop),
  `attachmentKinds` (`['image']` refuses a document with a sentence), `suggestions`, `questions`,
  `status`, `emptyAction`, `accessory`, `onKeyPress`, `speechLanguage`, `labels`, `onError`.
  `AliaChatContent` (so the sheet and the screen) renders it with photos, voice and suggestions;
  a host gets today's behaviour with no setup.
- **The sheet's composer is the panel, not the pill.** The pill has no mode selector, status tab
  or question slot, which the Alia app needs; the sheet and the app now draw the same card. The
  agent-working light (`ComposerLoader`) is not drawn around it, as in the app: a turn in flight
  is its stop control and the thread's thinking line.
- **Photos are `AliaAttachment`s** (exported type): the chat's picked photos wait as the same
  tiles a dropped or pasted image becomes, with the same remove and error states.
- **`AliaChatLabels` gains** `composerMessage`, `composerAddMenu`, `composerModes`,
  `composerVoice`, `composerSend`, `composerStop`, `composerRemove`, `composerRetry`,
  `composerUntitled`, `fileReadFailed`, `fileTooLarge`, `fileEmpty`, `fileUnsupported`,
  `dropHint`, `dropUnavailable` and `voiceError(code)`, all with English defaults. A nested
  `AliaChatLabelsProvider` now refines the labels already in reach instead of resetting them.
- **`usePendingQuestions(messages, isStreaming)`** (exported) is the "asked above the composer,
  put away until she asks again" rule both the chat and the app used to keep a copy of.
- **`classifyIntake` / `MAX_ATTACHMENT_BYTES`** (from `@alia.onl/sdk/tools`) are the rules a file
  passes to be attached.
- **The sheet focuses its composer once it has presented.** `AliaChatSheet` hands each sheet's
  `animatedProgress` (Bloom's own "fully presented" signal, no timer) to its chat, whose composer
  takes focus when it reads `1`: the person can type at once and the keyboard opens on native. It
  focuses once per `present()` for the main sheet and for the conversation sheet over it; dragging
  a sheet part-way and letting go does not take the focus again. `AliaChatContent` takes
  `presentedProgress` for a host that builds its own sheet; the screen and the app's own screens
  pass none and keep their focus. Not verified on a device.

A voice call that cannot speak ends and says why, instead of listening on in silence:

- **`requestSpeechClip` throws a `SpeechClipError`** (exported) with the route's HTTP `status`,
  its typed `code` (`SPEECH_UNAVAILABLE`, `SPEECH_LIMIT_REACHED`, `SPEECH_REJECTED`,
  `SPEECH_PROVIDER_FAILED`, `SPEECH_GENERATION_FAILED`, `INVALID_REQUEST`, `NOT_AUTHENTICATED`, or
  `null`), `retryable` and `requestId`. An empty token is `NOT_AUTHENTICATED` without a request.
- **`useVoiceRoom` ends the call when a clip cannot be made or played**, after the answer has
  finished streaming into the transcript, with `errorCode` `synthesis-unavailable`,
  `synthesis-limited`, `synthesis-rejected`, `synthesis-failed`, `not-authenticated` (no session
  token) or `not-played`; `synthesisError` is the `SpeechClipError` behind it. A turn no longer
  skips a sentence it could not speak, and `turnErrorCode` is no longer `not-played`.
- `VoiceErrorCode` gains the four `synthesis-*` codes; an app that translates every code needs
  their sentences.

## 13.1.0

The chat works in any app without host setup it did not document in code:

- **The avatar loads.** The chat mounts Bloom's `AgentAvatarProvider` itself, pointing at Alia's
  shared runtime (`ALIA_CHARACTER_RUNTIME_URL`, served with CORS open); a host that serves its own
  passes `characterRuntimeUrl`. Before, an app that had not hosted the 214 MB runtime showed
  Bloom's "unavailable" state.
- **The empty chat greets.** With no `welcomeGreeting` it greets the signed-in person by name
  (`labels.greeting` / `labels.greetingNamed`). Before, it drew nothing.

## 13.0.0

Fixes found by driving the sheet end to end (the sheet shows plans, links citations, nests lists):

- **A plan is drawn.** `plan_preview` was parsed but the sheet passed no handlers, so the card
  never showed. `useAliaChat` now returns `approvePlan` / `rejectPlan` (approve collapses the
  card to "approved"; reject collapses it and stops the turn) and `AliaChatContent` uses them
  unless the host passes its own.
- **Citations link.** `[n]` markers in a reply link to their sources (`linkifyCitations`,
  `normalizeCitationMarkers`, `citationLabel` are exported from `@alia.onl/sdk/tools`; the app
  re-exports them instead of keeping a copy).
- **Nested lists** draw under their parent instead of inline beside it.
- A finished research step reads "Researched", not "Researching".
- A turn that ends at a question card with no sentence before it counts as answered.

- **BREAKING: an agent is drawn with the look the server stores for it.** `agentCharacter(id)` (a
  look hashed from the id) is removed; `readAgentCharacter(value)` parses a stored character
  (Bloom's `parseAvatarCharacter`) and falls back on `DEFAULT_AGENT_CHARACTER`. The `alia.agent`
  event carries `agentCharacter`, and `agentInfo` has `character`. `AliaChatAgent` has `character`;
  `AliaChatSheet` / `AliaChatScreen` take `agents` (the host's directory) so a delegation's
  thinking avatar is the agent's own before its answer arrives. Needs a server that sends
  `agentCharacter`; release this SDK first, since the stream parser rejects unknown keys.
- **The one who answers thinks with its own avatar, and it is the same avatar that settles under
  the reply** (Bloom's `AgentReplyIdentity`, as in the multi-agent chat). While Alia works, her
  avatar is the indicator, large with "Thinking…", where the `AgentThinking` line was; when her
  text starts it shrinks under it with her name. A call to an agent (`delegateToAgent` /
  `askAgent`, its `agentId` and `agentName` or `agent` arguments) opens the agent's message at
  once, empty and thinking, and its answer fills that same message, so the avatar never remounts;
  an agent that never answers leaves no message. Alia's reply now carries her identity row, as the
  agents' do.
  The reasoning is part of that same component (`AgentReplyIdentity`'s `reasoning`): while the
  turn thinks, "Thinking… ⌃" folds it under the avatar's row, and once the reply starts it is the
  closed "Thought for N seconds" block above it (`ThinkingBlock` draws nothing while it streams, so
  there is one thinking indicator, not two).
- **No jumps of height, and no flash of the wrong thinker.** A reply, a new row, the reasoning and
  a thinking agent's avatar open and close with their height eased (Bloom's `Collapsible`, now
  with `appear`) instead of popping. Alia is shown thinking only once she has for a moment, so a
  turn she hands to an agent at once shows the agent thinking, not Alia for an instant first.
- **Bubbles are equal on every side as the eye reads them.** An agent's bubble sets its top and
  bottom padding from the reply's text metrics (`AgentReplyBubble`'s `text`, 16 on 28 here), so
  the gap from the edge to the text is the same above, below and at the sides. Nothing is cut:
  an open `Collapsible` no longer clips.
- **The greeting's avatar flies up into the header's profile** as the conversation begins
  (Bloom's `avatar-flight`: `useAvatarFlights`, `AvatarAnchor`, `AvatarFlightLayer`), across the
  main and conversation sheets. `AgentProfile`'s new `avatarHidden` keeps the header's avatar
  waiting for it. Needs a Bloom with `avatar-flight` (after 10.3).
- **`AliaChatSheet` opens the conversation in a second sheet stacked over the main one.** The
  main sheet stays on the greeting, the suggestions and the composer; the first turn (typed or a
  suggestion) opens a fresh conversation sheet on top, whose back button (and the menu's Clear)
  closes just that sheet, back to the main screen. A phone gets sheets flush with the screen
  edges, with the composer clearing the home indicator; from tablet width (768 px) they float.
  `AliaChatContent` gains `onStart` (hand an empty chat's first turn to the host) and
  `initialTurn` (a turn sent once on mount).
- **The empty chat looks and behaves like the Alia app's, from the same code.** The avatar sits
  beside the greeting (`AliaWelcomeMessage`, now just the greeting: always side by side, no
  `hideMark`, no suggestions) and the header shows Alia's profile only once there is a
  conversation. The suggestions are one-line rows **over the composer** (`ComposerSuggestions`),
  and from two typed characters they become matches with the typed part highlighted, arrows /
  Enter / Escape through the composer's `onKeyPress`. The app now draws its greeting and its
  suggestions with these same components and only supplies its API's data.
- **Several agents in one turn.** A delegated agent's answer (`alia.agent`) is now its own
  message with its name and avatar, placed before Alia's reply as the app places it, so a turn
  with Lumi, Atlas and Sol shows three speakers. Before, every answer was merged into one message
  under the last agent's name. Alia's reply is dropped when she said nothing after handing over.
- **A delegated agent shows its 3D avatar.** The speaker line of an agent's message is Bloom's
  `AgentAvatar`, not an image (an agent's account has none): the character comes from the agent's
  id (`agentCharacter(id)`, exported), so the same agent looks the same everywhere and two agents
  in a turn are told apart. The app draws its agents' messages with the same avatar.
- **Agents are bubbles, and the header holds the team.** As in Bloom's multi-agent chat, a
  delegated agent's reply is a tinted bubble with its avatar and name beneath it. Once agents have
  answered, the header profile stacks Alia with up to two of them and names them together
  ("Alia + Lumi + Atlas"). `headerLeading` / `actions` receive `agents` in their state
  (`AliaChatState`, `AliaChatAgent`), and `AliaChatHeader` takes `agents`.
- **The row under every reply is Bloom's multi-agent one**: helpful, unhelpful and copy as 22px
  tiles with 12px icons (read aloud is a fourth tile where the host reads), replacing the
  `AiChatFeedbackRow`. New label keys `helpful` and `unhelpful`.
- **Built on Bloom's `agent-reply`** (peer `@oxy.so/bloom ^10.1.1`): replies, their identity line and
  action tiles, and the header profile are Bloom's `AgentReply`, `AgentReplyBubble`,
  `AgentReplyIdentity`, `AgentReplyActions` and `AgentProfile`, the pieces `MultiAgentChat` is made
  of, not copies. Pressing the profile makes every avatar in it wave.
- **Questions are asked above the composer, not in the thread.** What Alia asks in her last turn
  (`askUserQuestion`) docks above the composer as Bloom's `Questionnaire`, with a dismiss; typing a
  reply answers just as well. The thread keeps the questions as plain lines (`AskedQuestions`).
  **Breaking:** `QuestionCard` is now the docked questionnaire (`onSubmit` required, new
  `onDismiss`) and no longer draws a read-only variant; the `onAnswerQuestions` prop of the message
  list is gone. `pendingQuestions` joins `@alia.onl/sdk/tools`.
- **The voice bar is Bloom's voice controls.** `VoiceControls` draws Bloom's `@oxy.so/bloom/voice`
  `VoiceControls` (microphone and end) under the status text, instead of `CallControls`, which is
  made for a dark call stage and lost its captions on the chat's light surface.
- **The header is back, the profile, share and a menu.** Bloom's `PageHeader` with a back button at
  its start, and at its end share and a three-dots menu (Bloom's `DropdownMenu`, aligned to its
  button) holding Clear and the host's rows. Over the empty chat there is no bar: nothing to do
  there. In the sheet, back returns to the main screen (a fresh chat) and the sheet stays open.
  **Breaking:** `AliaChatHeader` / `AliaChatSheet` / `AliaChatScreen` lose `onClose`; they take
  `onBack` (screen), `onShare` and `headerMenu`; the labels `close` becomes `back`, `share`,
  `more`.
- **The chat follows Bloom's theme, not the system's scheme.** `AliaMarkdown` and the sheet read
  the app's resolved mode: a person who chose light on a dark OS got white text on a light surface.
- **Every icon is Bloom's.** The voice button is `RiVolumeUpLine` (it was Entypo); the app's clock,
  robot and connector glyphs are `RiTimeLine`, `RiRobot2Line`, `RiPlugLine` and the SVG generator
  is gone; `@expo/vector-icons` is no longer a peer of the SDK.
- **Greeting.** The avatar (88px) above the text, both centred; `max-w-xs`, so it always sets in two lines; more room above than below. The Alia app draws the same.
- Peer `@oxy.so/bloom ^10.2.1` (scrollbar, pill groups, header scrim, voice controls).
- **Breaking:** `WelcomeSuggestion { id, title, description }` becomes `AliaSuggestion { id, text }`
  (`text` is what is shown and what is sent). New optional props on the sheet, screen and content:
  `suggestionMatches` and `onSuggestionQuery(query)`, so a host can search as the person types.
  New exports: `ComposerSuggestions`, `useComposerSuggestions`, `useSuggestionQuery`,
  `composerCompletions`, `Completion`, `AliaSuggestion`.

## 12.0.0

Breaking: Bloom 10 peer; the `header` render prop replaces the breadcrumb path (`title`, `actions`)
and the mark-state context. Hosts on Bloom 9 stay on 11.1.0.

- **The `@oxy.so` peers are open-ended** above their floors (`bloom >=10.0.0`, `core >=3.0.0`,
  `services >=8.0.0`). The `^10.0.0`, `^4.0.0` and `^11.0.0` caps made each new Oxy major a peer
  conflict in every app until this package republished; apps always run the latest Oxy SDK.

- **`AmbientField` takes `layout="sheet"`** for a short card (the chat's sheet): the blobs are
  drawn at the size of a phone screen, spread wider and shifted back to the right, cropped by the
  card's edges. It is asked for, not inferred from the field's height, so a short app screen is
  never reinterpreted. `AmbientField`, `AliaAvatar` and `AliaChatHeader` are memoised and the
  chat body no longer repaints them on every streamed token; read-aloud and starting a call no
  longer change identity per flush. `AliaAvatar` takes `portrait` (a still thumbnail, used for
  the sidebar's permanent mark).
- **One `header` render prop** on `AliaChatContent`, handed `hasMessages`, `clear` and the live
  avatar `markState`; the breadcrumb path (`title`, `actions`) and the mark-state context are gone.
- The profile and the screen's background are NativeWind classes with Bloom tokens
  (`bg-background-full`, `group-hover/profile:…`), not JS-computed colours.
- **Bloom is a peer at `^10.0.0`** (was `^9.0.0`). Bloom 10 makes an avatar one flat
  `AvatarCharacter`; `AliaAvatar` is `{ preset: 'blue_beret', accessory: 'none', color: 'orchid' }`
  and no longer builds a `config`. Hosts mount `AgentAvatarProvider` as before. Hosts on Bloom 9
  stay on the previous release.

## 11.1.0

Alia can ask clarifying questions, as ChatGPT and Claude do.

- **New:** `QuestionCard` (Bloom's `Questionnaire`: single or multiple choice, a free-text
  "Other", one question per step), drawn under a reply that asked. `AliaChatMessageList`
  renders it from the turn's `askUserQuestion` tool call; `AliaChatContent` sends the
  answers as the person's next message (`onAnswerQuestions` on the list, for hosts that
  compose their own).
- **New, pure** (root entry and `@alia.onl/sdk/tools`): `askedQuestions`, `formatAnswers`,
  `isQuestionInvocation`, `ASK_USER_QUESTION_TOOL`. The question is the stored tool call, so
  it survives a reload; it is answered once any later message exists, typed or picked.
- The turn **ends** at the card: the server stops after the call and writes no answer under it.

## 11.0.0

The chat UI is Bloom's, not a copy of it. Breaking:

- **Bloom is a peer dependency** (`@oxy.so/bloom ^9.0.0`; with `@oxy.so/services`
  11.2.0-oxy-one.5 and `@oxy.so/core` 4.5.0-oxy-one.1 it is the newest set that
  satisfies every peer range). The host must mount `BloomProvider`.
- **Alia's avatar is Bloom's 3D character.** The host mounts `AgentAvatarProvider`
  with the URL of the hosted `character-runtime` (see the README). New:
  `AliaAvatar`. `IdentityMark` stays only for an agent's likeness.
- **Removed exports:** `Button`, `buttonVariants`, `buttonTextVariants`, `Text`,
  `TextClassContext` (use `@oxy.so/bloom/button` and `typography`), and
  `ThinkingIndicator` (`AgentThinking`) and `Reasoning`, `ReasoningTrigger`,
  `ReasoningContent` (the reasoning block is `AgentThinking` with children). `zeego`, `class-variance-authority` and
  both `@radix-ui` packages are no longer dependencies.
- **Composer:** Bloom's `ComposerPill` with a Photos entry in its add menu; the picked photos are its own `attachments`, not a strip mounted above it. Photos are
  now actually sent, as `image_url` parts: `useAliaChat().send(text, { images })`
  (the old composer collected attachments and never sent them). The autocomplete
  props (`useSuggestions`, `onSuggestionUsed`) are gone; nobody passed them.
- **Sheet:** `AliaChatSheet` is Bloom's `BottomSheet`, detached, radius 40. The
  header is Bloom's `PageHeader` (avatar over a name capsule; press it for a wave).
  `AliaChatScreen` uses the same header; `headerLeft` and `headerRight` still work.
- **Chat parts:** the thread uses `AiChatUserMessage` and `AiChatFeedbackRow`, replies
  render code through Bloom's `CodeBlock`, research through `WebSearch`, and
  reasoning through `AgentThinking`. The welcome is the app's: the greeting at
  display size and the suggestions as compact rows.
- **Voice controls:** `VoiceControls` is Bloom's `CallControls`; its `primaryColor` prop
  is gone (Bloom paints from the theme). The plan card is `Card`, `Item` and `Button`;
  editing a message uses Bloom's `Textarea`; the agent line shows a Bloom `Avatar`.
  Colours come from Bloom's theme and tokens, not hard-coded values or the host's
  shadcn classes. `lucide-react-native` and `expo-blur` are no longer used here.
- **The turn's work is drawn as the app draws it.** Tool calls are Bloom's `TaskList` and
  `WebSearch`, driven by `revealed` from the calls that have really arrived, through one
  shared mapping: `webSearchLog`, `taskListLog` and `isWebInvocation` (root entry), and the
  pure `@alia.onl/sdk/tools` entry (`toolCallStatus`, `extractCitationSources`,
  `getToolDoneLabel`, `getToolPillLabel`), which the app now imports instead of keeping
  copies. `ResearchProgressCard` and the `onToolResultPress` prop are gone: research is a
  step of the `WebSearch` trail, and a tool row is not a button. The words of the log are
  English unless the host passes `labels.workLog` (a translator keyed like the app's).
- **One animated background.** The ambient gradient (three blurred, drifting colour fields
  that answer the live audio level) is the app's `AmbientField`, now exported by the SDK
  with `PARALLAX_DURATION` and `PARALLAX_EASE`; the chat draws it as its container's
  background and the app imports it from here. `VoiceOverlay`, `AudioWaveVisualizer` and the
  `primaryColor` props that fed them are gone.
- **Errors:** a failed voice call or dictation goes to `onError` when the host gives one and
  to Bloom's `toast` otherwise (the host needs a `ToastOutlet`; `OxyProvider` mounts one). A
  voice session reports why it ended: `onEnd(error?)`.
- **Thread:** the messages are a Bloom `AiChatThread` inside `AiChatContainer` with
  floating chrome, so the conversation scrolls behind the header and the composer with
  Bloom's edge fades. The `scrollOffsetY` plumbing is gone.
- **New:** `labels` on `AliaChatSheet` and `AliaChatScreen` to translate the chat's
  own copy; `AliaChatLabels` and `DEFAULT_LABELS` are exported.

## 10.1.1

`ChatTextInput` no longer passes `placeholderClassName`. No styling runtime ever
read it (react-native-css maps only `className` on `TextInput`, and the
placeholder colour comes from the `placeholder:text-muted-foreground` class), and
react-native-css 3.1.0-rc.0, the compiler Bloom 7.28+ requires, dropped the type
declaration that let it compile, so apps that type-check this package's source
failed on it. Nothing renders differently.

## 10.1.0

A failed turn is a typed error. Alia now answers an inference failure before any
output with its error envelope (an in-stream error frame, or an HTTP 503/500)
instead of an "all models are busy" answer. `AliaChatStreamError` (now exported,
with `AliaChatFailure`) carries `status`, `code`, `retryable`, `retryAfter` and
`reference` from either. The stream reader also accepts `alia.context` and
`alia.agent_turn`, which it used to reject as unknown events, ending a streaming
turn before its answer or its error could be read.

## 10.0.4

Admit `@oxy.so/services` 11 and `@oxy.so/core` 4 alongside the earlier majors.
Services 11 / core 4 move Android identity to Commons over signature-protected
IPC (OxyHQ/oxy#1388); the SDK imports only `useOxy` from
`@oxy.so/services/ui/client`, unchanged, and nothing from core. No code changed.

## 10.0.3

Admit `@oxy.so/services` 10 alongside 8 and 9. The SDK uses the unchanged
`useOxy` client API; this peer-only patch supports apps upgrading to Bloom 6.

## 10.0.2

### Oxy through `@oxy.so/services/ui/client`

`useAliaChat`, `useTTS` and `useVoiceRoom` import `useOxy` from
`@oxy.so/services/ui/client` instead of the root barrel. The root re-exports
every sign-in panel and the Commons QR encoder, and Metro does not tree-shake,
so a consumer of either entry shipped all of them; in Mention they reached the
initial web bundle. `ui/client` exports the same `useOxy` in services 8 and 9,
so the peer range is unchanged. `check:entries` now fails if either entry
imports the root again.

## 10.0.1

### `@oxy.so/services` 9 is admitted

The `@oxy.so/services` peer is now `^8.0.0 || ^9.0.0`. Services 9.0.0 changes
only its Bloom peer (to Bloom 5); the one thing this package takes from it,
`useOxy`, is the same in both, so an app can move to Bloom 5 without this
package refusing the services it needs. No code changed.

## 10.0.0

### Peers: `@oxy.so/core` `^3.0.0`, `@oxy.so/services` `^8.0.0`

**Breaking.** Core 3 is the namespaced Oxy client (`oxyServices.session`,
`oxyServices.users`, …): the SDK now reads the session token as
`oxyServices.session.accessToken` instead of `getAccessToken()` /
`httpService`, so it runs only on a host with core 3 and services 8 — one app
holds one Oxy SDK. Nothing in the SDK's own API changes.

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
