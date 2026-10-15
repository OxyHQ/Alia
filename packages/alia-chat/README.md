# @alia.onl/sdk

Alia's chat SDK for React Native and Expo apps built on Oxy: the chat sheet and
screen, the streaming hook, speech in and out, and the primitives they are made
of. It renders inside the one `OxyProvider` your app already mounts and sends
the signed-in user's Oxy session with every request; it never holds a token of
its own.

The package ships **raw TypeScript source** — `main`, `types` and every
`exports` entry point at `src/`. Your bundler compiles it with the rest of your
app, which is why the section on endpoints below matters more than it would for
a prebuilt library.

## Install

```sh
bun add @alia.onl/sdk
```

`react`, `react-native`, `@oxy.so/core`, `@oxy.so/services`, `@tanstack/react-query`
(the conversation runtime's cache; `OxyProvider` mounts the client) and the Expo modules
listed under `peerDependencies` in `package.json` are yours to install. Metro
must resolve package `exports` (`resolver.unstable_enablePackageExports = true`,
the default in Expo SDK 53+), because every icon import is a subpath.

The chat is built from Bloom (`@oxy.so/bloom`, a peer dependency): mount Bloom's
`BloomProvider` above it, with the one `KeyboardProvider` your app already has.

Alia's avatar is Bloom's 3D character (`AgentAvatar`). It draws through a runtime of
static files (about 214 MB), which the chat loads from Alia's own origin
(`ALIA_CHARACTER_RUNTIME_URL`, served with CORS open), so the app hosts nothing and mounts
no avatar provider. An app with a strict CSP allows `https://alia.onl` in `script-src` and
`connect-src` (and `'wasm-unsafe-eval'`). To serve your own copy instead, serve the Bloom
package's `assets/character-runtime/` directory unchanged and pass the URL of `runtime.mjs`
as `characterRuntimeUrl` to `AliaChatSheet` or `AliaChatScreen`; native avatars run in a
WebView, so there the URL must be absolute and reachable from the device.

The empty chat greets the signed-in person by name ("Hi Nate, what's on your mind?"); pass
`welcomeGreeting` to say something else, or `labels.greeting` / `labels.greetingNamed` to translate it.

Failures (a voice call that cannot start, a dictation error) are shown with Bloom's `toast`,
so the app needs a `ToastOutlet` (`OxyProvider` mounts one), or pass `onError` to handle them.

The chat's own copy is English. Pass `labels` to `AliaChatSheet` or
`AliaChatScreen` to translate it (`AliaChatLabels`; anything omitted stays
English). Bloom's own strings follow `BloomProvider`'s `locale`.

Entry points:

- `@alia.onl/sdk` — the conversation screen (`AliaChatScreen`, `AliaChatSheet`,
  `AliaChatContent`) with its voice call included: the button that opens it, the
  bar with its honest state, the notices (failure, moved to another device, time
  limit) and the transcript in the same thread. Also dictation, read-aloud,
  the conversation runtime, primitives. The call loads on the first call.
- `@alia.onl/sdk/runtime` — the conversation data layer alone (hooks, cache, stores,
  `AliaRuntimeProvider`), for a sidebar or a test that must not load the chat UI.
- `@alia.onl/sdk/model` — the conversation as pure data (the records, the timeline, the thought
  panel's steps and sources, tool cards, the markdown export): no React, no Oxy client.
- `@alia.onl/sdk/voice` — the call's parts (`VoiceSession`, `useVoiceRoom`,
  the audio engine) for a host that builds its own screen.

Voice is on by default; `voice={false}` makes a chat text-only, and
`voice={{ canStartVoice, onVoiceBlocked, onCallEnded, onNotice, isFocused }}` brings
what only the host knows (the plan and credits gate, what to refresh when a call
ends, where notices go). The conversation a call lives in is the chat's own. Its words are `labels.voiceControls`,
`voiceError`, `voiceEnded`, `voiceEndingSoon` and `voiceBlocked`. A host with its
own screen uses `useVoiceLauncher` and `AliaVoiceCall`, the same pieces.

## Speech

Nothing is recognized on the device. Speech is recognized by Kaana, through
Alia (Alia ADR 0017):

- **Dictation** (`useDictation`, the composer's mic) records a clip — the
  browser's `MediaRecorder`, or the `expo-audio` recorder on iOS and Android —
  and, when the person stops, sends it to `POST /v1/audio/transcriptions`.
  The text arrives once, never partially. Five minutes per clip. Free on every
  Alia plan.
- **A voice call** (`useVoiceRoom`, `VoiceSession`) is a realtime
  speech-to-speech session: a WebSocket to Alia's `GET /v1/voice/session`
  carrying PCM16 24 kHz audio both ways. Turn detection and barge-in are the
  model's; tools run in Alia; the transcript is stored in the conversation.
  Voice calls need a paid Alia plan and use credits per minute.

Audio reaches Alia, Kaana and the model's provider; Alia logs no audio and no
transcript content.

On iOS and Android a call needs
[`react-native-audio-api`](https://github.com/software-mansion/react-native-audio-api)
(a peer of the SDK: the conversation screen includes the call)
and its config plugin, then a new native build:

```json
["react-native-audio-api", {
  "iosMicrophonePermission": "Allow $(PRODUCT_NAME) to hear what you dictate and say in voice calls.",
  "iosBackgroundMode": false,
  "androidForegroundService": false,
  "androidPermissions": ["android.permission.RECORD_AUDIO"]
}]
```

Dictation needs only `expo-audio` (already a peer). Pass `lang` to both hooks
(`speechLanguage` to `AliaComposer`) to follow your app's language.

## Use

```tsx
import { AliaChatScreen } from '@alia.onl/sdk';

export function Assistant() {
  return <AliaChatScreen />;
}
```

`AliaChatScreen` is a full-screen route: it pads itself by the top and bottom
safe-area insets, so render it where no tab bar or other bottom chrome is drawn.
On iOS and Android its composer rises with the keyboard through
`react-native-keyboard-controller`, which needs the app wrapped in its
`KeyboardProvider` (re-exported here).

The sheet, the screen and the Alia app are three frames around ONE conversation runtime
(see [The conversation runtime](#the-conversation-runtime)): they list, open, create, send,
stop, retry, edit and clear conversations through the same hooks, and a conversation started in
one is the same conversation in the others.

## An "Ask Alia" button with her live avatar

```tsx
import { AliaAvatarIcon, useAliaActivity } from '@alia.onl/sdk';

<Button icon={AliaAvatarIcon} onPress={openAlia}>Ask Alia</Button>;
const state = useAliaActivity(); // 'idle' | 'thinking' | 'working' | 'writing'
```

`AliaAvatarIcon` is a Bloom icon component (`BloomIconComponent`): pass it as `icon` /
`leadingIcon`. It draws the live 3D avatar at the icon size under its own
`AgentAvatarProvider` (`ALIA_CHARACTER_RUNTIME_URL`), and plays what Alia is doing.

`useAliaActivity()` is the busiest of two sources, so a button reacts even with the sheet closed:

- a turn running in this app: every `useConversationThread` publishes its lifecycle to a shared store;
- her runs for the signed-in person elsewhere (background work, another device): the API's
  `alia:activity` event on the person's `user:<id>` room, over ONE Socket.IO connection per
  API origin, opened with the Oxy session's token only while someone is signed in and a
  consumer is mounted, closed with the last one. A run that goes quiet for 90 s is treated as over.

`socket.io-client` is a regular dependency, not a peer: the SDK owns this connection and an
app should not have to install a transport to use a button.

## The composer

The sheet, the screen and the Alia app share one composer, `AliaComposer`: Bloom's
`ComposerPill` with files by paste and drop (read with real progress, retried, refused with a
sentence), dictation, suggestions over the field and Alia's questions docked above it.
`AliaChatSheet` and `AliaChatScreen` render it with photos, voice and suggestions, and
`AliaChatSheet` focuses it once the sheet has presented. To build your own surface, mount it and
pass what the surface has:

```tsx
import { AliaComposer } from '@alia.onl/sdk';

<AliaComposer
  value={draft}
  onValueChange={setDraft}
  onSubmit={send}
  busy={isStreaming}
  onStop={stop}
  modes={powerLevels} // the mode selector; omit to hide it
  mode={level}
  onModeChange={setLevel}
  addMenu={groups} // the add menu's rows, and what pressing one does
  onAddMenuSelect={onAdd}
  attachments={files} // omit `onAddAttachment` and the composer takes no paste or drop
  onAddAttachment={addFile}
  onRemoveAttachment={removeFile}
  attachmentKinds={['image']} // what your send carries; others are refused with a sentence
  labels={{ composerSend: 'Enviar' }} // anything omitted is English
/>;
```

## The conversation runtime

Everything that is a conversation lives in `src/runtime`, in layers that depend only downward:

| Layer | What | Public names |
| --- | --- | --- |
| Transport | Alia's REST API over the signed-in person's Oxy client (token, refresh and the single 401 replay are Oxy's); the turn's SSE stream | `useAliaApi`, `AliaApiError` |
| Model and state | the records, React Query keys and the cached lists; zustand stores for the composer drafts and the hand-off of a first message | `Message`, `Conversation`, `aliaQueryKeys`, `useComposerDraftStore`, `useConversationStore` |
| Hooks | `useConversations` (the list, paginated), `useConversation` (one, with its history), `useCreateConversation`, `useRenameConversation`, `useDeleteConversation`, `useClearConversation`, and `useConversationThread`: the live thread of one conversation — messages, `sendMessage`, `createNewConversation`, `editMessage`, `regenerateMessage`, `retryFailedTurn`, `stopGeneration`, `clearConversation`, `startOver`, `ensureConversation` | `use…` |
| UI | `AliaChatContent` (the conversation screen), `AliaChatScreen`, `AliaChatSheet` | components |

A turn goes to `POST {apiUrl}/alia/chat`; conversations to `{apiUrl}/conversations`.
`apiUrl` defaults to `EXPO_PUBLIC_ALIA_API_URL`, then `https://api.alia.onl`. A failure to
answer is a typed error that keeps the person's turn in the thread with a retry (`FailedTurn`),
never a filler message; running out of credits or hitting a rate limit is a `UsageLimitError`.

### Configure it once: `AliaRuntimeProvider`

Providers nest and merge, so the sheet works with no provider at all and the Alia app mounts
one above its routes. Everything is optional.

```tsx
import { AliaRuntimeProvider, type AliaRuntimeHost } from '@alia.onl/sdk';

const host: AliaRuntimeHost = {
  // navigation: the runtime created or chose a conversation / the open one is gone
  openConversation: (id) => router.push(`/c/${id}`),
  closeConversation: () => router.replace('/'),
  // what only the host can show: credits, an artifact panel, a haptic tick
  onUsage: (frame) => updateCredits(frame.credits_remaining),
  onArtifact: (artifact) => rightPanel.show(artifact),
  turnRequest: () => ({ webSearch: composerMenu.webSearch, agentMode: composerMenu.agentMode }),
};

<AliaRuntimeProvider
  apiUrl="https://api.alia.onl"
  offline={accountScopedStore}  // optional: where a 401-ed session keeps its conversations
  streamFetch={expoFetch}       // optional: a fetch that can stream a body on native
  host={host}                   // memoise it
>
  {children}
</AliaRuntimeProvider>;
```

The sheet and the Alia app differ ONLY in what they put there:

```tsx
// The sheet: nothing to configure; the chat keeps its own conversation.
<AliaChatSheet ref={sheet} />

// The Alia app: its route owns the conversation, its sidebar reads the same list.
<AliaChatContent
  conversationId={id}
  onConversationChange={(next) => router.replace(next ? `/c/${next}` : '/')}
  runtime={host}
  model={powerLevel}
/>
function Sidebar() {
  const { data } = useConversations(); // the very query the thread keeps up to date
  …
}
```

### Voice lives in the conversation

A call always has a home. With a conversation open the call lives in it; on a new-chat screen
the conversation is created when the call starts (after the plan/credits gate) and the call
opens on the screen that shows it. That is one code path for the sheet, `AliaChatScreen` and the
Alia app (`useVoiceLauncher`'s `resolveConversation` and `useVoiceCallRequests`):

- the sheet has no routes, so the chat itself switches to the new conversation and the call opens
  in place;
- the Alia app's new-chat route is replaced by the conversation's (`host.openConversation`), and
  the call opens on that screen, which takes the pending request.

**Who decides which conversation is open:** the host, when it navigates (it passes
`runtime.openConversation`, or an outer `AliaRuntimeProvider` has one); otherwise the chat.

## Where the SDK stands on `/v1/chat/completions`, and the consumer-backend path

Since 17.0.0 the SDK speaks only to Alia's product routes (`/alia/chat`, `/conversations`),
as the Alia app always has. `/v1/chat/completions` remains Alia's public API for third-party
callers who bring their own UI and no conversations ([ADR 0010](https://github.com/OxyHQ/Alia/blob/main/docs/adr/0010-alia-keeps-a-product-api-credentials-come-from-oxy-console.md)),
but no SDK surface calls it: a "chat without conversations" mode had no user left, so it was
deleted along with `useAliaChat`.

The product routes answer browsers only for Alia's own origins (exact-origin allowlist in
`packages/api/src/lib/cors-origins.ts`); `/v1` is public CORS. Consequences:

- **Native apps** are unaffected (React Native sends no `Origin`).
- **Web builds on Alia's origins** (`alia.onl`, `console.alia.onl`, `mention.earth`) work directly.
- **Web builds on any other origin** must put their own backend between the SDK and Alia and point
  `apiUrl` at it. The backend forwards every request under that base URL to Alia server-to-server
  (a server sends no `Origin`, so Alia answers it on its credential alone), with the
  `Authorization` header it received — the signed-in user's Oxy access token — and streams the
  SSE body back unchanged:

```ts
import express from 'express';

const ALIA = 'https://api.alia.onl';
const app = express();
app.use(express.json({ limit: '10mb' })); // photos travel inline in the turn

app.use(async (req, res) => {
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  const authorization = req.get('authorization');
  const upstream = await fetch(`${ALIA}${req.originalUrl}`, {
    method: req.method,
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      Accept: req.get('accept') ?? 'application/json',
      ...(req.method === 'GET' || req.method === 'DELETE'
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    body: req.method === 'GET' || req.method === 'DELETE' ? undefined : JSON.stringify(req.body),
    signal: controller.signal,
  });
  res.status(upstream.status);
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // keep proxies from buffering the SSE stream
  res.flushHeaders();
  if (upstream.body === null) return void res.end();
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    res.end();
  }
});

app.listen(3000);
```

Authentication is `authenticateTokenOrApiKey` (`packages/api/src/routes/chat.ts`): an Oxy
session token, verified with Oxy and metered to that user's Alia entitlement. There is no
consumer-application credential for these routes yet — that is Oxy Applications' to issue
(OxyHQ/oxy#972). The alternatives (a CORS policy for registered consumer origins) are recorded
in [#244](https://github.com/OxyHQ/Alia/issues/244).

`model` is a power level (`auto`, `instant`, `medium`, `high`, `xhigh`, `pro`, `ultra`) or an
exact `publisher/model`; it is sent as given, and omitted the server's default answers. The SDK ships no model identifier of its own.

## Scripts

```sh
bun run typecheck       # tsc --noEmit
bun run test            # vitest
bun run check:entries   # the root entry reaches the call only through its lazy import; no retired modules
```

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`.
