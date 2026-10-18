# @alia.onl/sdk

Alia's chat SDK for React Native and Expo apps built on Oxy: the conversation (the chat sheet,
the screen, the thread, the thought panel and the composer), the streaming hook, speech in and
out, and the primitives they are made of. It renders inside the one `OxyProvider` your app already mounts and sends
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
(the conversation runtime's cache; `OxyProvider` mounts the client), `react-native-css`
(the thread's images take `className`) and the Expo modules listed under `peerDependencies` in
`package.json` — among them `expo-clipboard` and `expo-web-browser`, which the thread's copy
button and its sources use — are yours to install. Metro
must resolve package `exports` (`resolver.unstable_enablePackageExports = true`,
the default in Expo SDK 53+), because every icon import is a subpath.

The chat is built from Bloom (`@oxy.so/bloom`, a peer dependency): mount Bloom's
`BloomProvider` above it, with the one `KeyboardProvider` your app already has.

Alia's avatar is Bloom's 3D character (`AgentAvatar`). It draws through a runtime of
static files (about 214 MB), which the chat loads from Alia's own origin
(`ALIA_CHARACTER_RUNTIME_URL`, served with CORS open), so the app hosts nothing and mounts
no avatar provider. To serve your own copy instead, serve the Bloom
package's `assets/character-runtime/` directory unchanged and pass the URL of `runtime.mjs`
as `characterRuntimeUrl` to `AliaChatSheet` or `AliaChatScreen`; native avatars run in a
WebView, so there the URL must be absolute and reachable from the device.

A web app with a Content-Security-Policy composes the SDK's into its own instead of listing
Alia's origins by hand: `@alia.onl/sdk/csp` exports `ALIA_SDK_CSP` and `withAliaSdkCsp(extensions)`
in the shape of `@oxy.so/core`'s `OxyCspExtensions` (a leaf entry, safe on a server):

```ts
import { withAliaSdkCsp } from '@alia.onl/sdk/csp';
app.use(createOxySecurityHeaders({ csp: withAliaSdkCsp(APP_CSP_EXTENSIONS) }));
```

It declares the API and its WebSocket (`connect-src`), the avatar runtime and the voice call's
worklets on `https://alia.onl` (`script-src`, with `'wasm-unsafe-eval'` for the runtime's
WebAssembly), attachments and read-aloud clips (`img-src`, `media-src`). No `blob:` script:
the worklets are a content-addressed file on `alia.onl`, not a blob URL.

The empty chat greets the signed-in person by name ("Hi Nate, what's on your mind?"); pass
`welcomeGreeting` to say something else, or `labels.greeting` / `labels.greetingNamed` to translate it.

Failures (a voice call that cannot start, a dictation error) are shown with Bloom's `toast`,
so the app needs a `ToastOutlet` (`OxyProvider` mounts one), or pass `onError` to handle them.

`AliaAskProvider` follows the language Oxy Services resolves for the active account, including
language changes while its sheet is open. The SDK ships English and Spanish (regional Spanish tags
such as `es-ES` and `es-MX` use Spanish); other languages fall back to English. `AliaChatSheet` and
`AliaChatScreen` select their built-in copy from `labels.locale`. Pass `labels` to override any copy
(`AliaChatLabels`), or `labels.t` for another catalogue. Nested overrides preserve the surrounding
chat's translations. Bloom's own strings follow `BloomProvider`'s `locale`.

Entry points:

- `@alia.onl/sdk` — the conversation screen (`AliaChatScreen`, `AliaChatSheet`,
  `AliaChatContent`, the thread `AliaThread`, the work panel `ThoughtPanel`) with its voice call included: the button that opens it, the
  bar with its honest state, the notices (failure, moved to another device, time
  limit) and the transcript in the same thread. Also dictation, read-aloud,
  the conversation runtime, primitives. The call loads on the first call.
- `@alia.onl/sdk/runtime` — the conversation data layer alone (hooks, cache, stores,
  `AliaRuntimeProvider`), for a sidebar or a test that must not load the chat UI.
- `@alia.onl/sdk/model` — the conversation as pure data (the records, the timeline, the thought
  panel's steps and sources, tool cards, the markdown export): no React, no Oxy client.
- `@alia.onl/sdk/csp` — the CSP the SDK needs from a host page (above).
- `@alia.onl/sdk/voice` — the call's parts (`VoiceSession`, `useVoiceRoom`,
  the audio engine) for a host that builds its own screen.

Voice is on by default; `voice={false}` makes a chat text-only, and
`voice={{ canStartVoice, onVoiceBlocked, onCallEnded, onNotice, sounds }}` brings
what only the host knows (the plan and credits gate, what to refresh when a call
ends, where notices go, the cues it plays). Whether the screen holding the call is the one on
show is `isFocused` of the chat. The conversation a call lives in is the chat's own. Its words are `labels.voiceControls`,
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

## Any agent, from any app

Every agent — Alia included — is the same agent (ADR 0020), and any Oxy app opens any agent the
person can reach. The wire contract is [`docs/agent-embedding.md`](../../docs/agent-embedding.md).

```tsx
import { AliaAskProvider, useAskAgent } from '@alia.onl/sdk/ask';

<AliaAskProvider
  agents={{ alia: {}, sindi: { id: SINDI_AGENT_ID } }}  // no id = Alia
  clientContext={`Homiio — viewing listing ${listing.id}`}   // the screen, built per turn
  hostTools={{
    app: 'homiio',
    definitions: [{ name: 'apply_search', description: '…', inputSchema: { type: 'object' } }],
    execute: async (action) => applySearch(action.input),  // → { outcome: 'applied' | … }
  }}
  toolRenderers={{ 'homiio:searchListings': (r) => <ListingCards data={r.output} /> }}
  onFeatureLocked={(key) => showHomiioPlus(key)}
  onShare={({ token }) => shareSheet(`https://homiio.com/shared/${token}`)}
>
  {children}
</AliaAskProvider>;

const { ask, resume, dismiss } = useAskAgent();
ask('sindi', { text: 'Is this flat a good price?' }); // signed out: Oxy's sign-in instead
resume('sindi', conversationId); // a stored conversation, where the person left it
dismiss(); // e.g. after a host tool changed the page under the sheet
```

Mount it from `@alia.onl/sdk/ask`: that entry is the provider and its hook alone, and the sheet
loads with the first `ask` (fetched in the background once the person is signed in), so the chat
stays out of the app's entry bundle. The root entry exports the same two, with the whole chat.

The sheet offers the person's latest conversations with its lead under the greeting
(`recentConversations={false}` turns it off). The code that configures the sheet sits above it, so
`AliaAskProvider` forwards a ref to the same `AliaAsk` for it.

- **The lead.** `agent={{ id }}` (on `AliaChatSheet`, `AliaChatScreen` and `AliaChatContent`) makes
  that agent the conversation's lead: its greeting, name, character and starters
  (`GET /v1/agents/:id/profile`) and the header's first avatar. Omitted, Alia.
- **The participants.** `AliaChatState.participants` is `{ lead, joined }`; draw it with
  `AliaParticipants` (or `AliaParticipantsHeader` inside Bloom's AI chat shell) wherever the
  chrome puts the conversation's title. When the lead consults an agent (`alia.agent_start`), the
  agent's reply is drawn under its own identity and its avatar flies from there into the header —
  Bloom's multi-agent join — which gains the agent when it lands.
- **Host tools** are UI effects the app's own client performs. An `alia.host_action` is executed
  once, by `execute`, and its outcome is sent with the next request; an outcome whose request did
  not get through goes with the one after. They are never authority over data.
- **Tool renderers** are keyed `<app>:<tool>`, parsed only from `oxy_<app>__<tool>` /
  `self_<app>__<tool>`, and drawn before the generic tool card — for consulted agents too.
- **Feature gates.** The attach menu offers photos and files as the lead offers them
  (`GET /v1/agents/:id/features`); a locked row, and a turn refused with
  `feature_entitlement_required`, call `onFeatureLocked(key)`. Documents are uploaded to the
  person's Oxy Files (`oxyServices.assets.upload`) and sent as a `file` part.
- **Sharing.** `onShare` receives `{ conversationId, token, expiresAt }` once the SDK has minted
  the link; `useShareConversation()` mints and revokes, and `<AliaSharedConversation token>` reads
  one, signed in or not. `useConversations({ agentId })` lists the person's conversations with one
  agent.

## An "Ask Alia" button with her avatar

```tsx
import { AliaAvatarIcon, useAliaActivity } from '@alia.onl/sdk';

<Button icon={AliaAvatarIcon} onPress={openAlia}>Ask Alia</Button>;
const state = useAliaActivity(); // 'idle' | 'thinking' | 'working' | 'writing'
```

`AliaAvatarIcon` is a Bloom icon component (`BloomIconComponent`): pass it as `icon` /
`leadingIcon`. At rest it is her **still**, a picture made ahead of time and shipped in the source
(`src/lib/alia-avatar-still.generated.ts`, Bloom `Avatar`'s `characterStill`), so a header that
shows her fetches nothing of the 3D runtime. While she thinks or works she goes live under its own
`AgentAvatarProvider` (`ALIA_CHARACTER_RUNTIME_URL`) and plays her working turn; reduced motion
keeps her a still. Change `ALIA_AVATAR` and run `bun run render:avatar-still` (a test fails until
you do); run it too when a Bloom upgrade changes how the runtime draws her.

`useAliaActivity()` is the busiest of two sources, so a button reacts even with the sheet closed:

- a turn running in this app: every `useConversationThread` publishes its lifecycle to a shared store;
- her runs for the signed-in person elsewhere (background work, another device): the API's
  `alia:activity` event on the person's `user:<id>` room, over ONE Socket.IO connection per
  API origin, opened with the Oxy session's token only while someone is signed in and a
  consumer is mounted, closed with the last one. A run that goes quiet for 90 s is treated as over.

`socket.io-client` is a regular dependency, not a peer: the SDK owns this connection and an
app should not have to install a transport to use a button.

## The thread

The sheet, the screen and the Alia app draw ONE thread, `AliaThread` (inside `AliaChatContent`),
and nothing else draws turns: Bloom's AI Chat turns with their reveal, the feedback row and the
long-press menu; the reply's Markdown with its rich blocks, its code card and its references;
the work log (`WebSearch`, `TaskList`) and the "Worked for…" line; tool cards; the questions Alia
asked; the plan an agent shows; the failed turn's toast with its Retry; day lines; the window over a long
history with the scroll that goes with it; and the card of an agent's run. What a frame adds is
around it, never in it (`tests/components/thread/one-thread.test.tsx` mounts it both ways and
holds the rows equal, and fails if anything else imports Bloom's thread).

An agent's permanent thread is `threadHandle`: the conversations behind the open one are paged in
above it, the thread can be searched (`state.openSearch`), and a hit opens the stretch around it.
Those routes (`/agents/thread/:handle/…`) answer Alia's own origins only, as `/conversations` did
before `/v1`: an embedding Oxy app has no agents of its own and passes no handle.

### The work panel, and where it goes

A turn that used tools has a "Worked for…" line; pressing it selects the turn (`useThoughtStore`)
and asks the host to show it (`runtime.showThought`). `ThoughtPanel` — steps, sources, activity —
draws the selection wherever the host puts it: the Alia app's right panel, the sheet's own sheet
over the conversation. A host without `showThought` has no panel, and the line is plain text. A
running turn's first tool opens the panel by itself (`showThought('automatic')`) unless the host
declines because something else is open. A file the turn generated opens where the host keeps its
files (`ThoughtPanel`'s `outputActions`).

### Cards: why weather, market and FairCoin are the SDK's

The weather, market quote and FairCoin price cards are the thread's. Their tools
(`getWeather`, `getMarketQuote`, `getFairCoin`) are in the pipeline every Alia surface calls, and
the card's numbers travel in the message itself (the whole of every range is in the snapshot, so a
thread reopened next month shows the figures it was answered with). So any surface that draws
Alia's reply draws them. The scheduled-task card is the same card with one difference: it points at
a screen of the host's, so it is a link only where `runtime.openAutomation` says where it goes.

## The composer

The sheet, the screen and the Alia app share one composer, `AliaComposer`: Bloom's
`ComposerPill` with files by paste and drop (read with real progress, retried, refused with a
sentence), dictation, suggestions over the field and Alia's questions docked above it.
`AliaChatSheet` and `AliaChatScreen` render it with photos, voice and suggestions, and
`AliaChatSheet` focuses it once the sheet has presented. The conversation also owns the draft
(per conversation and account), sending, rewriting a question already sent, the questions Alia
asked and the power-level selector: give `AliaChatContent` an `onModelChange` and the composer
offers the seven levels (`auto` … `ultra`) with `deviceModels` of the person's own after them;
give it an `addMenu` (rows and what pressing one does) and that menu replaces the photos one. To build your own surface, mount it and
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
| UI | `AliaChatContent` (the conversation screen), `AliaChatScreen`, `AliaChatSheet`, `AliaThread`, `ThoughtPanel` | components |

Between the hooks and the components are the hooks of what a person does with a conversation —
`useChatComposer` (the draft, send, edit, suggestions), `useChatVoice` (the call and its
transcript in the thread), `useThreadView` (the present or a moment of an agent's thread),
`useOpenThought`, `useReadAloud`, `useMessageVote` — each used by exactly one layer above it.

An agent's thread and runs (`useThreadHistory`, `useThreadSearch`, `useThreadWindow`,
`useAgentActivity`) read the agent routes through the same API and cache.

A turn goes to `POST {apiUrl}/v1/chat/completions`; conversations to `{apiUrl}/v1/conversations`.
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
  turnRequest: () => ({ webSearch: composerMenu.webSearch, deepResearch: composerMenu.deepResearch }),
  // where the work of a turn is read; return false to decline an automatic opening
  showThought: (opening) => (opening === 'automatic' && panel.isOpen ? false : panel.show('thought')),
  openAutomation: (id) => router.push(`/automations/${id}`), // a scheduled-task card is a link
  faviconUrl: (url) => favicons.of(url), // the work log's source icons
  // the edges of a turn this runtime sends
  onTurnStart: () => executor.beginTurn(),
  onTurnEnd: () => executor.runHeldBack(), // finished, stopped or failed: once per turn
};

<AliaRuntimeProvider
  apiUrl="https://api.alia.onl"
  offline={accountScopedStore}  // optional: where a 401-ed session keeps its conversations
  streamFetch={expoFetch}       // optional: a fetch that can stream a body on native
  speech={{ voice: 'female', tone: 'brief', language: 'es-ES' }} // read-aloud, dictation, calls
  host={host}                   // memoise it
>
  {children}
</AliaRuntimeProvider>;
```

`onTurnStart` is called just before each turn the runtime sends — from the composer, a retry,
an edit or a regenerate — so a host can take what the turn will be judged against at that send.
`onTurnEnd` is called exactly once for each turn the runtime sends, when it stops streaming —
the answer was written, the person pressed Stop, or the turn failed — and only while the
conversation that sent it is still mounted. A host that holds back what would take the chat off
the screen (a host tool that navigates away) runs it there; a surface that left mid-turn is never
called back, so what it held back goes with it.

The sheet and the Alia app differ ONLY in what they put there:

```tsx
// The sheet: nothing to configure; the chat keeps its own conversation.
<AliaChatSheet ref={sheet} />

// The Alia app: its route owns the conversation, its sidebar reads the same list.
<AliaChatContent
  surface                       // the container draws the page's card
  conversationId={id}
  threadHandle={handle}         // an agent's thread: history above, search
  model={powerLevel}
  onModelChange={setPowerLevel} // the composer offers the levels
  addMenu={{ groups, onSelect }} // the host's rows
  chrome={(chat) => ({ header, title, project, actions: <Actions chat={chat} /> })}
  renderUsageLimit={({ error, dismiss }) => <UsageLimitDialog error={error} onDismiss={dismiss} />}
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

## Which API the SDK calls

The SDK is Alia's product client and speaks **only to `/v1`**, Alia's product API: a bearer of
the signed-in person's Oxy session, no cookies, and public CORS — so it works in the browser of
every Oxy app, on that app's own origin, with nothing to configure and no backend in between.

- A turn: `POST {apiUrl}/v1/chat/completions` — the same handler `/alia/chat` mounts, with every
  `alia.*` stream event, `conversationId` and the stored history.
- Conversations: `{apiUrl}/v1/conversations` (list, open, create, save, rename, delete, clear,
  vote). A person's session only: an application key or a bot secret is refused, because a
  conversation is somebody's private history.
- Dictation, read-aloud and the voice call: `/v1/audio/*` and `/v1/voice/session`.

`apiUrl` defaults to `EXPO_PUBLIC_ALIA_API_URL`, then `https://api.alia.onl`. `routes.ts` holds
the paths, and `tests/runtime/v1-only.test.ts` fails if the transport builds a URL outside `/v1`.
The one exception is the agent routes (`AGENT_ROUTES`: an agent's thread and its runs), which only
Alia's own clients use.

`model` is a power level (`auto`, `instant`, `medium`, `high`, `xhigh`, `pro`, `ultra`) or an
exact `publisher/model`; it is sent as given, and omitted the server's default answers. The SDK
ships no model identifier of its own.

## Scripts

```sh
bun run typecheck       # tsc --noEmit
bun run test            # vitest
bun run check:entries   # the root entry reaches the call only through its lazy import; no retired modules
```

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`.
