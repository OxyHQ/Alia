# 17. Voice is a realtime speech-to-speech session through Kaana; dictation is Kaana transcription

*La voz es una sesión realtime de voz a voz servida por Kaana; el dictado es transcripción de Kaana.*

**Status:** Accepted by the owner on 2026-10-15. The owner answered the first draft's questions on 2026-10-15;
the answers are decisions here, not open points (see "Owner's answers").

**Amended by:** ADR 0020 §3 (2026-10-16) — no agent asks for approval, so approvals, their rows and their events are deleted (`0098_retire_agent_approvals`). A call's tools never send `approval.requested`; nothing in a call waits on, or files, an approval.

**Date:** 2026-10-15

**Implementation:** phase 1 (Alia) is built and tested on branch `feat/voice-realtime`,
against a port of `@kaana.ai/sdk` and a contract-faithful fake; at the owner's request it
also carries the phase-4 cut of on-device recognition (`@alia.onl/sdk` 15.0.0). Not
switched on: phases 1–3 of Kaana and Oxy are pending. See "Implementation status" at the
end.

**Supersedes, when accepted:** [ADR 0013](./0013-voice-runs-on-the-device-livekit-and-cohost-are-retired.md)
decisions 1 ("the device listens"), 2 ("a call is a loop of chat turns") and 3 ("Oxy
speaks", for calls only), and its "Kept: dictation (`useSpeechToText`)". ADR 0013's
retirement of LiveKit, cohost and `voice-minutes` (decision 4) stands. A note goes at
the top of ADR 0013 when this record is accepted, not before.

**Depends on:** Kaana ADR 0002 (`kaana.ai/v1`, `@kaana.ai/sdk`, `realtime.connect`),
proposed on branch `docs/kaana-sdk-adr`, PR OxyHQ/Kaana#172. That ADR reserves
**Alia ADR 0016** for "Alia consumes `@kaana.ai/sdk`" (its header, `KA:17-20`); this
record therefore takes 0017 and assumes 0016.

**Evidence prefixes.** Unprefixed paths are Alia `origin/main` `b0f7e6954`.
`K:` Kaana `origin/main` `c1132d1`. `KA:` Kaana branch `origin/docs/kaana-sdk-adr`,
file `docs/adr/0002-kaana-public-api-and-sdk.md`. `KC:` Kaana branch
`feat/kaana-contracts` `aa8166f` (**local, not pushed** on 2026-10-15; the
`@kaana.ai/contracts` 4.0.0 source of Kaana ADR 0002 phase 1.1). `O:` OxyHQServices
`origin/main` `9d262f7b8`, under `packages/api/src/` unless stated.

## Context

**The owner's decisions, 2026-10-15, are the source of this ADR**, and it does not
reopen them:

1. Alia's voice mode runs on **realtime speech-to-speech models served by Kaana**
   (OpenAI Realtime, xAI Grok Voice Agent, ElevenLabs conversational …): turn
   detection and barge-in happen on the server, never in the browser's or the OS's
   recognizer. LiveKit stays retired.
2. Kaana gets its own SDK, `@kaana.ai/sdk`, and public API `https://kaana.ai/v1`, in a
   clean cut without adapters (`@oxy.so/core/inference` and `api.oxy.so/v1` go away).
   Oxy Console stays the developer portal. Kaana resolves power levels.
3. People choose power levels, not models; the voice model is computed. The owner's
   data only with the owner present; tools run in Alia, never in the client; memory
   per actor; inference failures are typed (`failTurn`).
4. Read-aloud stays on `/v1/audio/speech`.
5. The composer's microphone (dictation, not the voice mode) transcribes with a Kaana
   transcription model and stops using the browser's or the OS's recognizer.
6. (Answers to this record's first draft.) Build directly on `@kaana.ai/sdk`, no
   shortcut through the current edge. **One active voice call per person**: a call
   opened elsewhere takes over and the old one hangs up. **Kaana serves whatever
   concurrency it is asked for**; per-app concurrency and spend limits are the app's
   configuration in Oxy Console, applied by Oxy's policy, never constants of Alia or
   Kaana. Call duration (30 min) and idle timeout stay Alia product rules. **Kaana
   enables and charges `inputAudioTranscription` inside the realtime session**, as
   OpenAI and xAI do. Voice mode stays in the paid plans (go/pro/max/ultra) and
   consumes credits per minute; **dictation is free on every plan**, the free one
   included. 5 min per dictation clip; the power level does not pick the realtime
   model; `/v1/voice/session` serves Alia's own apps only at first; sticky routing on
   the ALB and a drain window on deploys.

### What voice is today

- The device listens. Web uses the Web Speech API
  (`packages/alia-chat/src/lib/speech-recognition.ts:79-81`); iOS and Android use
  `expo-speech-recognition` (`speech-recognition.native.ts:207-217`). A call closes an
  utterance after 1100 ms of silence (`packages/alia-chat/src/hooks/useVoiceRoom.ts:119`)
  and treats two or more words as a barge-in (`:123`, `isInterruption`): echo
  rejection is a heuristic (ADR 0013 `:92-94`).
- Each utterance is a chat turn: `use-voice-mode.ts:96-108` sends it through the
  conversation's `sendMessage` with `responseMode: "voice"`; the API layers
  `prompts/voice.md` over the prompt (`lib/system-prompt-builder.ts:29-37,248-251`)
  and changes nothing else (`lib/chat/request-context.ts:1084`).
- The answer is synthesized sentence by sentence through `/v1/audio/speech`
  (`packages/alia-chat/src/lib/speech-synthesis.ts:122-125`).
- Dictation is the same recognizer: `AliaComposer` uses `useSpeechToText`
  (`packages/alia-chat/src/components/AliaComposer.tsx:224`); no audio reaches Alia.
- No capture of audio exists anywhere: no `MediaRecorder`, no PCM, no AudioWorklet.
  `expo-audio` (`packages/app/package.json:52`) only plays. The app also depends on
  `expo-speech-recognition` (`packages/app/package.json:73`) and its config plugin
  (`packages/app/app.json:41-48`).
- The `voice-mode` plan capability is checked **only by the app**
  (`packages/app/src/features/chat/ui/chat-page-content.tsx:321`); the API never reads
  it.

### What Kaana and Oxy have today

- **Kaana realtime exists, internal only.** `GET /internal/v1/realtime` (`K:docs/realtime.md:30-42`),
  a session is one request for attribution and settlement and lasts at most one hour
  (`:3-6`). Two adapters: `openai-realtime` and `xai-realtime`
  (`K:internal/provider/openairealtime/adapter.go:39`, `dialect.go:144`); attributed
  models `gpt-realtime-2`, `gpt-realtime-2.1`, `gpt-realtime-2.1-mini` and
  `x-ai/grok-voice-think-fast-2.0` (`K:configs/model-attribution.json:69-75`).
- **Only `conversation` sessions are served.** `transcription` and `translation`
  sessions are refused, and so is input transcription inside a conversation
  (`K:docs/realtime.md:715-731`): it runs a second model the contract's unit rule
  cannot price.
- **Tools are the client's.** Kaana relays `tool_call` events and expects a
  `function_call_output` item back (`K:docs/realtime.md:309`); neither Kaana nor
  Oxy executes them (`O:services/inferenceRealtime.service.ts:786`).
- **Turn detection and barge-in are server side**: `server_vad` / `semantic_vad` with
  `createResponse` and `interruptResponse` (`K:internal/contract/realtime.go:146-168`);
  xAI accepts only `server_vad` with both `true` (`K:docs/realtime.md:407-408`).
  `input_audio.speech_started` carries `audioStartMs`, `speech_stopped` carries
  `audioEndMs`, and `conversation.item.truncate` cuts an answer at what was heard
  (`KC:packages/contracts/src/public/realtime.ts:316-327,453-465`).
- **Metering.** OpenAI by audio tokens; xAI by `session_milliseconds` (wall clock,
  speech or silence) under `server_vad` at USD 0.08/min plus 0.004 per text item
  (`K:docs/realtime.md:486-548`; `KC:packages/contracts/src/public/money.ts:116-127`).
- **Limits are signed per session**: `maxDurationMs` (≤ 3 600 000), `idleTimeoutMs`,
  audio bytes, `maxResponses` (`KC:packages/contracts/src/public/realtime.ts:183-191`).
  The Oxy edge defaults are 10 min, 2 min idle and **20 responses**
  (`O:services/inferenceRealtime.service.ts:171-177`). Resume works only on the same
  Kaana task, within 30 s (`K:internal/realtime/manager.go:45`).
- **The Oxy edge** `GET api.oxy.so/v1/realtime` authenticates `oxy_sk_` or a service
  token, never a user session, and has no ephemeral token
  (`O:routes/inferenceRealtime.ts:15-16`). It names an exact model, never a routing
  profile (`O:services/inferenceEdge.service.ts:1123-1131`). It allows 16 concurrent
  sessions per credential per task (`O:services/inferenceRealtime.service.ts:155-160`).
- **Alia's internal pilot refuses realtime**, the way it refused speech before
  OxyHQ/oxy#1701: `controlledInputBudget` returns nothing for a non-completion
  (`O:services/inferenceInternalPilot.ts:104-109`). The text deployments do not
  include the voice route. The 2048-token output floor exceeds the voice route's
  `maxOutputTokens: 1` (`O:config/kaanaInitialCatalogue.ts:598-601`). USD 0.05 per
  request is far below a session's hold (USD 2.56 at defaults, `O:docs/inference/realtime.md:133-137`).
- **Transcription.** Kaana executes it internally (`openai-audio`, `deepgram`;
  `K:docs/openai-audio.md:42-76`, `K:docs/deepgram.md:15-19`). The Oxy edge does not
  mount `/v1/audio/transcriptions` on purpose: duration, which providers bill, is not
  derivable from the bytes, so no sound cost ceiling exists
  (`O:routes/inferenceEdge.ts:1590-1621`).
- **ElevenLabs conversational is not in Kaana.** `elevenlabs` serves `audio_speech`
  only. `eleven_v3_conversational` is deliberately absent as "realtime WebSocket"
  (`K:configs/model-attribution.json:24`; `K:docs/elevenlabs.md:54`). ElevenLabs'
  agent platform runs its own LLM and tools. Its nearest raw form is "Speech Engine"
  (STT + turn-taking + TTS around your own LLM).

### What Kaana ADR 0002 brings

- `GET kaana.ai/v1/realtime?model=`: first frame `session.open`/`session.resume`, one
  grant per session, settled at close (`KA:427`). It also brings
  `POST /v1/audio/transcriptions`: multipart, ≤ 20 MiB, synchronous (`KA:423`).
- `@kaana.ai/sdk`: `realtime.connect(open): RealtimeSession` with `send`,
  `appendAudio(pcm16)`, `resume()` and `close(): Usage` (`KA:648-650,689-695`).
  `audio.transcriptions.create` (`KA:680-687`).
- Credentials: `oxy_sk_`, a service token with `aud: kaana.ai`, or an Oxy app user
  session (`KA:403-409`). **No ephemeral or client-secret token is specified.**
- The catalogue publishes voices (`id`, `name`, `languages`, `gender`), `languages`,
  input/output `audioFormats`, validated before reserving (`KA:453-470`;
  `KC:packages/contracts/src/public/catalogue.ts:340-420`). It also carries
  `capabilities.realtime {transports, sessionKinds}` (`:106-125`) and `powerClass`
  (`:468`).
- Transcription in the grant: Kaana sends Oxy `audioInputMilliseconds`, "the duration
  of the uploaded audio", as a sizing fact (`KC:packages/contracts/src/internal/grant.ts:126-127`).
  Duration-metered audio is counted in integer milliseconds
  (`KC:packages/contracts/src/public/money.ts:110-114,144-147`), not seconds.
- Phases: contracts (1) → Oxy internal authorization API (2) → public server and
  `@kaana.ai/sdk@1.0.0` (3) → consumers, Alia fourth (4) → deletion of `api.oxy.so/v1`
  and `/internal/v1/realtime` (5) (`KA:736-829`).

## Decision

### 1. Topology: the client talks to Alia; Alia holds the Kaana session

```text
app / SDK ──WSS /v1/voice/session──▶ Alia API ──@kaana.ai/sdk realtime.connect──▶ kaana.ai/v1/realtime ──▶ provider
  PCM16 24 kHz binary frames             │  instructions, tools, memory,
  + Alia's JSON events                   │  tool execution, persistence,
                                         │  credits, typed errors
                                         └─@kaana.ai/sdk audio.transcriptions (user transcript, dictation)
```

Alia opens **its own WebSocket**, `GET /v1/voice/session` on `api.alia.onl`. It is
mounted with `ws` in `noServer` mode on the shared `node:http` server, exactly as
`lib/mcp-relay.ts:61-80` does so that socket.io's handshake is not stomped
(`index.ts:74-83`). The socket carries PCM audio and Alia's own small, versioned event
protocol. Alia is the only client of the Kaana session. It connects with
`@kaana.ai/sdk` under its service token (`aud: kaana.ai`, `X-Oxy-User-Id` = the
person). That is lane `service_token`, relationship `alia-kaana`, as for every other
Alia inference (`KA:122,310-317`).

Rejected: client ↔ Kaana directly, with an ephemeral token plus an Alia side channel
for tools. Why:

- **Tools must run in Alia.** Kaana sends `tool_call` to *its* client
  (`K:docs/realtime.md:309`) and has no sideband. A session has one WebSocket, and
  resume works only on the same task (`K:internal/realtime/manager.go:45`). With the
  device as Kaana's client, every tool call would land on the device and travel back
  to Alia. A tampered client could then skip, alter or invent tool results. OpenAI's
  WebRTC sideband (`?call_id=`) exists, but it is a provider feature: Kaana
  normalizes providers and offers nothing like it, and xAI has no equivalent.
- **The owner's data only with the owner present.** `requesterAccountId` decides which
  Oxy tools a turn gets (`lib/tool-pipeline.ts:152-161`). Alia can enforce that only
  if it builds the tool set and executes it for the authenticated socket. With a
  direct session, the device would also hold the system prompt, the memory and the
  tool schemas, and could rewrite them.
- **Billing and entitlements.** Alia charges its own credits and must gate on
  `voice-mode`. A direct session would need a Kaana credential minted for the device.
  ADR 0002 specifies none: no ephemeral token (`KA:403-409`), and the Oxy edge lists
  it as a follow-up (`O:routes/inferenceRealtime.ts:15-16`). A user-session lane
  would bill the app owner as `product_session` (`KA:325-328`) outside Alia's
  credits.
- **Persistence.** Transcripts must become messages of the conversation. The server
  sees every event; a direct client would have to report them, trusted.
- **Mobile.** A direct design would ship `@kaana.ai/sdk` and zod into the bundle
  (`KA` risk 9). Alia's protocol is a few event types over one socket.
- **Latency is the cost, and it is small.** Alia and Kaana both run in AWS
  `us-west-2` (`docs/deployment.md:3`; `KA:578`). The extra hop is one in-region relay
  of ~40 ms audio frames. Model latency (hundreds of ms) dominates. WebRTC to the
  provider would beat a WebSocket on lossy mobile networks, but Kaana's only realtime
  transport is `websocket` (`KC:packages/contracts/src/public/catalogue.ts:108-114`).

### 2. The realtime model is computed; power levels do not choose it

The voice session's model is an **internal computed exact model**, like the speech
and utility models (ADR 0012 §3, ADR 0014 §5). The person's power level does not
select it: realtime models carry no `powerClass`. Oxy refuses a routing profile for a
session (`O:services/inferenceEdge.service.ts:1123-1131`), and `?model=` takes a model
(`KA:427`). Alia's model selection (`lib/models/`, beside `rankSpeechModelIds`,
`lib/models/auto-selection.ts:214`) computes the candidates from `models.list` at
session open:

1. `capabilities.realtime.sessionKinds` contains `conversation` and `transports`
   contains `websocket`; `capabilities.tools` is `true`; audio in and out; and the
   model transcribes its input inside the session (the catalogue flag Kaana adds in
   phase 1, §6), because the person's words become messages (§3).
2. `audio.voices` has a voice whose `gender` is the product voice (`male` | `female`).
   The upstream voice id is sent to Kaana and **never shown or returned** (rule kept
   from `docs/voice.mdx:91-93`).
3. Not deprecated. Ordered by the catalogue's **`pricePerMinute`**, cheapest first.

*Amended 2026-10-16 (Kaana ADR 0003, contract set 6.0.0):* Kaana's API is one
canonical contract that gives every model the language, so no model is chosen or
excluded for its language any more: the app's BCP 47 locale is sent as it is. The
order is the catalogue's own `pricePerMinute`, no longer an estimate from units, and
a call is charged its minutes at that price.

The open is tried on at most two candidates, and only when the model itself refused
before any audio flowed (`model_not_found`, `unsupported_modality`, `invalid_request`
naming `voice` or `config`, `no_route_available`). Authentication, credit and rate
refusals fail at once, as speech does (`docs/voice.mdx:129-140`). Kaana never switches
models mid-session (`K:docs/realtime.md:133-136`), and neither does Alia.
`session.created` names the revision that serves (`KC:packages/contracts/src/public/realtime.ts:734-746`);
Alia prices with it and records it in `chat_analytics` as the turn's model. **The
model's and publisher's names may be shown; the operator never** (Alia `AGENTS.md`).

The power level still governs every **text inference a voice session causes**. Tools
that run their own inference (research, image generation, the background tasks a tool
starts) receive the conversation's level, or `auto`, exactly as in a typed turn.

### 3. The session

**Opening.** The client sends `session.start { conversationId, agentId?, voice,
locale }` as its first frame, after authenticating on the socket the way
`lib/mcp-relay.ts:86-121` does (first message carries the Oxy session token). Browsers
cannot set headers on a WebSocket. **Only a person's Oxy session from Alia's own apps
is accepted** (the app and the Alia surfaces built on `@alia.onl/sdk`). An `oxy_sk_`
machine credential (ADR 0010) is refused with `credential_not_supported`; opening the
route to third parties is a later, separate decision. Alia then runs, before dialling
Kaana:

- authentication, account and conversation ownership, the agent (`loadTurnAgent`);
- **`voice-mode` entitlement, now enforced by the server** (today only
  `chat-page-content.tsx:321`), and a credit reservation (§5);
- **the one-call rule** (§3a): this call becomes the person's only active call, and
  any other is hung up;
- the turn inputs, **extracted from `buildChatRequestContext`**
  (`lib/chat/request-context.ts:745-1076`) into a function that takes an identity
  instead of `req`/`res`: user memory, recalled memories, skills, Oxy profile,
  entitlements, agent. The chat handler and the voice session both call it, so voice
  never drifts from chat.

**Instructions** = `SystemPromptBuilder.buildMeasured({ …, responseMode: 'voice' })`
(`routes/v1/chat-completions.ts:317-334`), the same layers as a typed voice turn:
`prompts/voice.md` and no `askUserQuestion` card (`lib/system-prompt-builder.ts:248-256`).
Two sections are added for voice:

- **The recent conversation** as text inside the instructions, bounded in tokens.
  One instruction string, not one `conversation.item.create` per message, which xAI
  bills at USD 0.004 each (`K:docs/realtime.md:543-548`).
- **The session language.**

The contract caps `instructions` at **32 768 characters**
(`KC:packages/contracts/src/public/realtime.ts:130-133`). The voice instructions are
measured with `buildMeasured` at open. When they exceed the cap, the history section
shrinks first, then recalled memories. If they still do not fit, the session refuses
to open with a typed error rather than truncate the base prompt silently.

`instructions` and `tools` can be refreshed with `session.update`
(`KC:packages/contracts/src/public/realtime.ts:156-163`); voice and formats are fixed
at open.

**Memory per actor** is unchanged: an Alia session gets the person's memory and the
`saveUserMemory` family; an agent session gets `agent_memory_documents` and its
`memory` tool, never Alia's (`lib/tool-pipeline.ts:519-557`;
`lib/system-prompt-builder.ts`). Per-utterance memory recall (`runBeforeChatHooks`) is
not run inside a session in this decision: recall happens at open and through the
memory tools.

**Tools.** The set is `ToolPipeline.forUser(...)` (`routes/v1/chat-completions.ts:251-275`)
with `requesterAccountId` = the authenticated person on the socket. So an agent's
`oxy_*` tools reach its owner's apps only when that owner is the one talking (ADR
0015), and `self_*` tools act as the agent's bot.

- **Schemas.** Each tool is serialized with `asSchema(tool.inputSchema).jsonSchema`,
  the pattern of `lib/tool-budget.ts:430-450`. The set is limited to 128 tools
  (`KC:…/realtime.ts:140`) and starts from the routed active set (`loadTools` routing,
  `lib/tool-budget.ts`; ADR text written when the router was `useApps`). When the model calls `loadTools`, Alia widens the set
  with `session.update { tools }`.
- **Execution, in Alia only.** On a complete `tool_call`, Alia runs
  `tools[name].execute(args, { toolCallId, abortSignal })`. The precedent is
  `lib/chat/text-tool-fallback.ts:50-82`. Results are truncated by the same budget
  (`lib/tool-pipeline.ts:342-356`). Alia then answers with
  `conversation.item.create { function_call_output }` and, when the provider does not
  continue on its own, `response.create`. The client receives only `tool.started` /
  `tool.finished` with the tool's display name, for the call UI.
- **No tool runs on the device** and the device never sees a schema or a result
  payload. Tools that need an approval (`oxyApprovals`) send an `approval.request` to
  the call UI and wait. Tools that stream artifacts (`sseEmitter`) write into the
  persisted conversation and notify `message.updated`.
- **Time limit.** A tool call that exceeds it returns a typed tool error to the
  model. It is never an invented result.

**Turn detection and barge-in** are the provider's: `server_vad` with
`createResponse: true` and `interruptResponse: true` (the only mode xAI accepts;
`semantic_vad` where the model offers it). On `input_audio.speech_started`:

1. Alia forwards `user.speech_started` immediately.
2. The client flushes its playback queue and reports how many milliseconds of the
   current item it actually played.
3. Alia sends `conversation.item.truncate { itemId, contentIndex, audioEndMs }`, so
   the model remembers what was heard, not what was generated
   (`KC:…/realtime.ts:316-327`).

`isInterruption` and every client-side end-of-utterance timer are gone.

**Transcripts become messages of the conversation.**

- **The assistant side** is the provider's output transcript (`transcript.done`,
  `source: output_audio`, `KC:…/realtime.ts:508-530`). An interrupted answer is stored
  whole, marked interrupted with the heard milliseconds.
- **The person's side** is the session's own input transcription: Alia opens the
  session with `config.inputAudioTranscription { language }`
  (`KC:packages/contracts/src/public/realtime.ts:105-110`) and stores each
  `transcript.done` with `source: input_audio` (`:508-530`). The transcription model
  is "the deployment's own" (`:102`); Alia does not choose it. **Kaana refuses this
  today** (`K:docs/realtime.md:723-731`, `K:internal/provider/openairealtime/wire.go:342`).
  The owner's decision is that Kaana enables it and charges it inside the session, as
  OpenAI and xAI do. That is Kaana phase-1 work (§6), and Alia does no transcription
  of its own during a call.
- **Persistence.** Each pair is appended as it completes (not at the end of the call)
  with `saveConversation` (`lib/conversation-saver.ts:141`, append-only by `seq`):
  user message, assistant message, tool round trips (`lib/chat/tool-calls.ts:21-52`).
  The thread therefore survives a dropped call. Nothing is persisted for a response
  that produced no output, as for chat (`lib/chat-lifecycle.ts:87-98`).

**Ending a session.** A session ends for one of these reasons, and each one closes
the Kaana session (`close()` settles exactly once, `KA:693`) and reaches the client as
`session.closed { reason }`:

- the person hangs up;
- the screen loses focus, changes conversation or changes account (the rule of
  `use-voice-mode.ts:143-148`);
- **the person opened a call elsewhere** (`call-moved-elsewhere`, §3a);
- `max_duration` or `idle_timeout`;
- credits run out (§5);
- a typed error;
- Alia shutdown after the drain window (`server_shutdown`, §3b).

**Limits.** Duration and idle time are **Alia product rules**, the same for every
call. They are not capacity limits: capacity and spend belong to the app's policy in
Oxy Console (§5).

| Limit | Value |
|---|---|
| `maxDurationMs` | 30 min (contract ≤ 60 min; OpenAI 60, xAI 120) |
| `idleTimeoutMs` | 2 min |
| `maxResponses` | 500 (the edge default of 20 would end a call after 20 answers, `O:services/inferenceRealtime.service.ts:171-177`) |
| Audio bytes | sized to 30 min of PCM16 per direction |

History travels in the instructions, never as text items. The silence that ends a
turn is Kaana's default (`REALTIME_DEFAULT_SILENCE_DURATION_MS`), not Alia's.

The client shows a notice one minute before the duration ends. A new call in the same
conversation starts from the persisted messages.

**Reconnection.**

- **Client ↔ Alia.** When the socket drops, Alia keeps the Kaana session for a 30 s
  grace window and buffers events, bounded. The client resumes with
  `session.resume { voiceSessionId, afterSeq }`. **Sticky routing on the ALB** (§3b)
  brings the resume to the task that holds the session. If it lands elsewhere anyway
  (the task died), it fails `resume_unavailable`, and the client says so and offers a
  new call. A resume continues the same call row and is never a takeover (§3a).
- **Alia ↔ Kaana.** Alia calls `RealtimeSession.resume()` within Kaana's window
  (`KA:692`). If the Kaana task itself is shutting down (`server_shutdown`,
  `K:internal/realtime/manager.go:158-163`), resume cannot work: resume is per task.
  Alia then opens a new Kaana session with fresh instructions from the persisted
  messages, under the same call. The client shows `reconnecting` meanwhile, never
  `listening`.

#### 3a. One active call per person

**Rule.** A person has at most one active voice call, across devices and tabs. A new
`session.start` from the same person **takes over**:

1. The previous call hangs up with `session.closed { reason: 'call-moved-elsewhere' }`.
   Its device shows that state; it is not an error.
2. The conversation continues in the new call. If the new call opens the same
   conversation, its instructions include everything the old call persisted.

Dictation is not a call and is not affected. A `session.resume` is the same call, not
a new one.

**Authority is PostgreSQL**, Alia's only required store (`docs/deployment.md:27-31`).
A table `voice_calls` holds the following columns:

- `id`
- `oxy_user_id`
- `conversation_id`
- `agent_id`
- `holder_task`
- `status`, either `active` or `ended`
- `end_reason`
- `lease_expires_at`
- `started_at` and `ended_at`

A partial unique index on `(oxy_user_id) WHERE status = 'active'` makes two active
rows for one person impossible.

**Takeover runs in one transaction.** It takes
`pg_advisory_xact_lock(hashtextextended('alia:voice-call:' || user, 0))`, the
per-user lock idiom of `lib/product-credit-allocations.ts:44`. It ends the active row
(`end_reason = 'moved_elsewhere'`), whether its lease is live or expired, and inserts
the new one. Then:

- **The old call is on the same task.** The task finds the old call in its in-memory
  registry and hangs it up directly.
- **The old call is on another task.** The new task publishes `{ callId }` on a Redis
  channel, the cross-task pattern of `lib/inference/user-runtime-bridge.ts:202-222`.
  The holding task receives it and hangs up within milliseconds.
- **Without Redis, or if the message is lost**, the lease still decides. Every
  holding task renews its calls' leases every 10 s with
  `UPDATE voice_calls … WHERE id = $1 AND status = 'active'`. Zero rows updated means
  the call was taken over, and the holder hangs up. So the worst overlap without Redis
  is one renewal interval. A crashed task's rows simply stop renewing; an expired
  lease never blocks a new call.

**Hanging up on takeover.** The old holder flushes its pending messages
(`saveConversation`), closes its Kaana session (settling once) and publishes
`voice-call:ended { callId }`. The new call waits for that message for at most 2 s
before it builds its instructions, so the last exchange of the old call is in them.
If the message does not arrive, it proceeds: the person is already talking on the new
device.

#### 3b. Sticky routing and drains

- **Sticky routing.** Alia's target group on the shared ALB uses load-balancer cookie
  stickiness, so a client's `session.resume` reaches the task holding its call. The
  client keeps and resends the ALB cookie on the WebSocket upgrade; React Native's
  WebSocket takes headers, and browsers send it as a cookie. This is an oxy-infra
  change.
- **Drain window.** On deploy, a task leaves the target group and keeps serving its
  open sockets for the target group's deregistration delay, set **≥ 31 min** (the
  longest call plus margin). Only then does it receive SIGTERM. New calls go to new
  tasks. A call still open at SIGTERM ends with `server_shutdown`. This is an
  oxy-infra change too.
- **The cost.** An old task can run its code for up to 31 min after a deploy, while
  migrations have already run (a push to `main` deploys with migrations). Voice code
  must stay compatible with the schema of the next migration, the same rule as for
  any rolling deploy, but for longer.

**Failures are typed.** Every failure becomes `error { code, retryable, reference }`
followed by `session.closed`, the realtime counterpart of `failTurn`
(`routes/v1/chat-completions.ts:85-102`). Alia never synthesizes a spoken "sorry"
filler. The `KaanaError` classes (`KA:708-718`) map onto `VoiceErrorCode`s the app
localizes (`voice.errors.*`):

| Error | `VoiceErrorCode` |
|---|---|
| Unavailable, or no model | `realtime-unavailable` |
| Rate or billing | `realtime-limited` |
| Invalid or permission | `realtime-rejected` |
| Provider failure | `realtime-failed` |
| Alia's own conditions | `credits-exhausted`, `plan-required`, `not-authenticated` |
| Device | `mic-denied`, `mic-unavailable`, `connection-lost` |

### 4. The client

**Audio is PCM16, 24 kHz, mono** in both directions: Kaana's `pcm16_24khz`
(`KC:…/realtime.ts:54`), which every served provider accepts. Audio travels as binary
WebSocket frames of about 40 ms. Each outbound frame carries a short header naming the
assistant item, so playback position is exact for truncation. Events are JSON text
frames. Alia base64-encodes for Kaana; the device never does.

**Web.** `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true,
autoGainControl: true } })`. An `AudioWorklet` downsamples to 24 kHz PCM16, and a
second `AudioWorklet` plays a jitter-buffered queue, in one `AudioContext`. Browser
echo cancellation is reliable for audio played through an `RTCPeerConnection`, and
not proven for Web Audio playback in Chrome. **Measuring it is a release gate.** If
Chrome fails, playback is routed through a local `RTCPeerConnection` loopback in the
same page so the browser's AEC sees it as remote audio. The server still sees
WebSocket audio. Firefox has `AudioWorklet`, so calls stop being unsupported there.

**Expo native.** **`react-native-audio-api`** (Software Mansion), with its Expo
config plugin:

- **Capture and playback share one engine.** AEC cancels only what the same audio
  stack plays.
- **iOS** uses `iosVoiceProcessing: true` with category `playAndRecord`: Apple's
  Voice Processing I/O, with AEC, noise suppression and gain control.
- **Android** uses input preset `voiceCommunication`, `AudioRecord` with
  `VOICE_COMMUNICATION`, which engages the platform AEC.

`expo-audio` 57 is not enough. Its `AudioStream` captures PCM but opens
`MediaRecorder.AudioSource.MIC` with no AEC
(`node_modules/expo-audio/android/src/main/java/expo/modules/audio/AudioStream.kt:142`),
and it cannot play a PCM stream. `expo-audio` stays for read-aloud, sound effects and
dictation (§7).

**A new native build is required.** The `react-native-audio-api` plugin comes in and
`expo-speech-recognition` goes out (§6). Validation follows the repo's rules: the USB
Pixel 8a for Android, never the emulator; a Mac for iOS. Check echo with the speaker
at full volume, barge-in while Alia speaks, Bluetooth headsets, and the first seconds
of a call, when AEC is still converging. If `react-native-audio-api` fails the Android
AEC gate, the fallback is a small Expo module of Alia's own wrapping the same platform
APIs. It is not a return to the OS recognizer.

**Honest states.** `useVoiceRoom` exposes one state machine:

| State | Entered when |
|---|---|
| `connecting` | Socket open → authenticated → `session.start` accepted → Kaana `session.created` |
| `listening` | **Only** when Kaana confirmed the session **and** the capture engine delivered its first buffer **and** Alia acknowledged the first appended audio |
| `user-speaking` | On `user.speech_started` |
| `thinking` | From `user.speech_stopped` to the first answer audio or a tool start |
| `using-tool` | While a tool runs (display name only) |
| `speaking` | When the first answer frame is actually playing, not when it is received |
| `reconnecting` | During a resume |
| `ended { reason }` | After `session.closed`; `call-moved-elsewhere` is a reason, not an error |
| `error { code }` | After a typed error |

The level meter reads the real captured and played buffers. No state is inferred from
a timer.

### 5. Billing and credits

- **Oxy and Kaana.** A session is one Kaana request: one grant at open and one
  settlement at close, from Kaana's measured units (`KA:257-288,427`). Alia's lane is
  `service_token` / `alia-kaana` / `internal_metered` (`KA:122,310-317`).
- **Voice mode is a paid-plan feature.** `voice-mode` is enabled on go, pro, max and
  ultra (`internal/providers/lib/seed-features.ts:248-256,414,458,510,571`) and not on
  the free plan. The API checks it at `session.start`, not only the app. No
  `voice-minutes` allowance returns (ADR 0013, ADR 0005).
- **A call consumes credits per minute.** The rate is the real cost of a minute on
  the model that serves the call (ADR 0012: credits follow real cost; `creditsForCost`,
  `lib/credits-manager.ts:79`), so it is not a constant of Alia. At open Alia reserves
  a block of minutes (`reserveCredits`, `:150`). It settles each block from the units
  Kaana reports on `response.done` / `session.closed`, including the in-session input
  transcription, at the price of the revision that served (`finalizeCredits`, `:366`).
  It reserves the next block before the current one runs out. A refused reservation
  ends the call with `credits-exhausted` after the current spoken item, never
  mid-word. Under xAI's `session_milliseconds`, silence costs too; the idle timeout
  (2 min) bounds it. The call UI can show an estimate of the minutes the balance
  buys.
- **Inference that a tool causes** is charged by its own path, as in a typed turn.
- **Dictation is free on every plan, the free plan included** (§7). It needs no plan
  feature and charges no credits. Its cost is attributed to Alia's internal cost
  centre, as ADR 0005 requires of free usage. Abuse is bounded by the 5-min clip and
  by the per-user rate limit the `/v1` routes already apply (`apiKeyRateLimit`,
  `routes/chat.ts:41-47`).
- **Oxy and Kaana.** A call is one Kaana request: one grant at open and one settlement
  at close, from Kaana's measured units (`KA:257-288,427`). Alia's lane is
  `service_token` / `alia-kaana` / `internal_metered` (`KA:122,310-317`).
- **Capacity and spend are the app's configuration, not Alia's or Kaana's.** Kaana is
  a provider and serves the concurrency it is asked for. Alia sets no global cap of
  its own; its only rule is one call per person (§3a). The limits that apply to a
  realtime grant are those Oxy evaluates in `authorizations` from the **Alia app's
  policy in Oxy Console** (`KA:257-288` and the table at `KA:566-575`):
  - **concurrent realtime sessions** for the app (and per credential, if set);
  - **spend limits and budgets** for the account, the app and the credential
    (`evaluateSpendingLimits`, `O:services/spendingLimit.service.ts:141`; Console
    `billing/budgets`, `application-budgets-section.tsx`);
  - **rate limits** per credential and per app (`O:middleware/machineCredential.ts:347-361`);
  - **allowed models and price caps** from the routing policy
    (`resolveEffectiveRoutingPolicy`, `O:services/inferenceRoutingPolicy.service.ts:965`).

  Their values for the Alia app are set in Console. Today two of them are constants in
  code, and both stop being so in Oxy's phase-2 work: the internal relationship's
  `maxConcurrentRequests: 32` (`O:config/inferenceEconomicPolicy.ts:182`) and the
  edge's 16 sessions per credential per task
  (`O:services/inferenceRealtime.service.ts:155-160`, deleted with the edge). A
  realtime session holds its concurrency slot for its whole life, so session
  concurrency is configured apart from the request concurrency of text.
- **What changes in Oxy** (Kaana ADR 0002 phase 2, in the grant, not in the old edge):
  - The `alia-kaana` relationship admits `realtime_session` (`kind: conversation`,
    with input transcription) and `audio_transcriptions`, each under its own terms.
    This is the counterpart of #1701's `speech` block
    (`O:config/inferenceEconomicPolicy.ts:127-141,224-239`).
  - The app-policy fields above become Console configuration: session concurrency,
    and the relationship's concurrency and spend that are code today.
  - A transcription hold sized from the measured `audioInputMilliseconds`
    (`KC:packages/contracts/src/internal/grant.ts:126-127`).
- **What changes in Kaana:**
  - **Enable and meter `inputAudioTranscription` inside realtime sessions**, which it
    refuses today (`K:docs/realtime.md:723-731`). This needs a contract decision on its
    units: the ASR model's audio is reported beside the session model's units without
    double-counting the same audio, under the unit rule
    (`KC:packages/contracts/src/public/money.ts:110-114`). The catalogue also needs a
    flag saying a realtime model transcribes its input (§2).
  - Publish `capabilities.realtime` from its own inventory. Today it is Oxy metadata
    the inventory cannot carry (`K:docs/realtime.md:743-748`).
  - Publish `audio` (voices with `gender`, `languages`) for **realtime** models too,
    not only for speech models. ADR 0002 decision 9 says "each voice model", and
    realtime voices are still a free string (`K:internal/contract/realtime.go:241`).
  - Measure an upload's duration before asking for the grant (§7).
  - No concurrency constant of Kaana's own bounds Alia's sessions.

### 6. Sequencing against the Kaana SDK cut

**Build on `@kaana.ai/sdk` directly. Do not add a realtime client to
`@oxy.so/core`, and do not add a consumer of `api.oxy.so/v1/realtime`.** The edge is
deleted in ADR 0002 phase 5 (`KA:808-829`). A pilot patch to the old edge's
`inferenceInternalPilot.ts` would be thrown away when the pilot becomes grant `steps`
(`KA:300,310-317`). Dictation cannot use the old edge at all: it has no
`/v1/audio/transcriptions`.

What does not depend on the transport starts now, contract first. It is built against
`@kaana.ai/contracts` 4.0.0 (published in ADR 0002 phase 1.3, before the SDK) and a
fake upstream that speaks the public realtime schemas.

| Phase | Repo | Work |
|---|---|---|
| **0** | Alia | This ADR (proposed). On acceptance, a note at the top of ADR 0013, and `docs/voice.mdx` rewritten when the code lands. |
| **1** | Kaana | In ADR 0002 phase 1 (contracts 4.0.0): `audio` capabilities (voices with `gender`, languages) for realtime models; `capabilities.realtime` from Kaana's inventory; the definition of how `audioInputMilliseconds` is measured for an upload (container probe, refuse when unknown); **`inputAudioTranscription` enabled and metered inside realtime sessions** (units rule, adapters for OpenAI and xAI, a catalogue flag), per the owner's decision (§5). |
| **1** | Alia, in parallel | **API:** extract the turn inputs from `buildChatRequestContext`; `lib/voice/` (session orchestrator, tool bridge with JSON-schema serialization and executor by name, `session.update` widening, transcript persistence, rolling credit blocks, typed errors, the one-call rule with `voice_calls`, its migration and the Redis takeover channel, §3a); `GET /v1/voice/session` (`noServer` upgrade); `POST /v1/audio/transcriptions` (Alia product API, multipart, §7); realtime and transcription model computation in `lib/models/`; an upstream interface with a contract-faithful fake. **SDK** `@alia.onl/sdk` 14.0.0: `useVoiceRoom` over the socket with an audio-engine seam (web `AudioWorklet`; native `react-native-audio-api`), and `useDictation`. **App:** native build with `react-native-audio-api`; Pixel 8a validation of capture, playback and AEC against a local fake. |
| **2** | Oxy | In ADR 0002 phase 2: grant terms for `alia-kaana` `realtime_session` and `audio_transcriptions`; session concurrency and spend as app policy configured in Console (no code constants); the transcription hold from the measured duration. The Alia app's values set in Console. |
| **3** | Kaana / oxy-infra | In ADR 0002 phase 3: `/v1/realtime` and `/v1/audio/transcriptions` public. The end-to-end canary includes an `alia-kaana` realtime session with a tool call and input transcription, and a file transcription. **oxy-infra:** load-balancer cookie stickiness and a deregistration delay ≥ 31 min on Alia's target group (§3b); WebSocket idle timeouts cover a 30-min call (pings every 20 s, `K:internal/realtime/manager.go:62-65`). |
| **4** | Alia | Together with ADR 0016 (Alia's switch to `@kaana.ai/sdk`): the upstream becomes `realtime.connect` and transcription becomes `audio.transcriptions.create`. API deploy first (`test:pg` locally: a push to `main` deploys with migrations); then the SDK 14.0.0 and app release that **deletes on-device recognition** (below). App binaries already installed keep the old loop, which still works on `/alia/chat` + `/v1/audio/speech`. |
| **5** | Alia | Remove what the old binaries needed once their share is negligible (the `responseMode: 'voice'` path stays: it is public product API, and the session reuses its prompt layer). Docs. |

**Deleted in the phase-4 app/SDK release**, with no browser or OS fallback:

- `packages/alia-chat/src/lib/speech-recognition.ts`, `speech-recognition.native.ts`
  and `speech-recognition-types.ts`, and Android recognizer selection
  (`chooseSpeechRecognizer`);
- `useSpeechToText`, replaced by `useDictation` (§7); `lib/voice-text.ts`
  (`isInterruption`); `lib/voice-turn.ts` (`createAliaVoiceTurnSender`); the
  utterance-loop `useVoiceRoom`;
- `use-voice-mode.ts`'s `sendMessage` path;
- `expo-speech-recognition` from `packages/app/package.json`,
  `packages/alia-chat/package.json` (peer and dev) and the `app.json` plugin with
  `NSSpeechRecognitionUsageDescription` and the recognizer visibility query;
- `docs/native-validation.mdx` §8.4.

After this release no surface uses on-device recognition: neither dictation nor calls.
`expo-speech-recognition` joins `removed-dependencies-stay-removed.test.ts`.
Read-aloud (`useTTS`, `/v1/audio/speech`) is untouched.

### 7. Dictation: batch transcription through Alia

**API.** The composer's microphone records a clip and, on stop, uploads it to Alia's
`POST /v1/audio/transcriptions` (multipart). Alia calls Kaana
`audio.transcriptions.create` (`KA:680-687`) with the computed model and the language,
and the text goes into the draft. **Batch, not a streaming transcription session.**
Why:

- **Feasibility.** No Kaana adapter serves `transcription` sessions
  (`K:docs/realtime.md:715-722`), and Kaana found no WebSocket endpoint documented for
  OpenAI's. Batch transcription is already executed (`K:docs/openai-audio.md`,
  `K:docs/deepgram.md`) and is in the public surface (`KA:423`).
- **Cost.** Batch models cost about USD 0.003–0.006 per minute against about 0.017 for
  OpenAI's live transcription (pricing pages, 2026-10-15). Dictation is frequent and
  short.
- **Latency.** The text arrives after the person stops: one upload of a short
  compressed clip plus a batch transcription. Seconds have not been measured end to
  end through Kaana; that measurement is a release gate.
- **Experience.** The loss is live partial text while speaking. The composer shows
  recording (real level meter, elapsed time), then `transcribing`, then the text.
  Firefox, which has no Web Speech API, gains dictation. Streaming partials can return
  when Kaana serves `transcription` sessions, by a new record.

**Model.** Computed from the catalogue, no ids in code:

1. `capabilities.apiFormats` includes `audio_transcriptions`
   (`KC:packages/contracts/src/public/catalogue.ts:84-94`);
2. `audio.languages` covers the language;
3. `audio.audioFormats.input` includes the clip's media type
   (`KC:packages/contracts/src/public/audioFormats.ts:28-37`);
4. ordered cheapest per audio millisecond.

At most three attempts, and only on model refusals, as speech does. Calls do not use
this path: their transcript comes from the session itself (§3).

**Free on every plan.** Dictation needs no plan feature and charges no credits, the
free plan included (§5). The route uses the `/v1` middleware chain with its per-user
rate limit (`routes/chat.ts:41-47`). The 5-min clip bounds a single request.

**What Kaana and Oxy lack today, and how the new contract solves it.** Oxy refused to
mount transcription because no cost ceiling exists before the audio is decoded
(`O:routes/inferenceEdge.ts:1590-1621`). Under ADR 0002:

- Kaana parses the upload, which the payload now reaches first.
- Kaana reports `audioInputMilliseconds` as a grant fact
  (`KC:packages/contracts/src/internal/grant.ts:126-127`), and Oxy sizes the hold from
  it.
- Settlement uses the measured `audio_input_milliseconds`
  (`KC:packages/contracts/src/public/money.ts:110-114`): billing per millisecond, not
  per second, so a 12.5 s clip is exactly 12 500.

The contract branch does **not** carry a "maximum duration per route" field. The Oxy
comment named it as one option, and the probe as the other. What it does carry is the
measured fact. How Kaana measures it (container probe; refuse an upload whose duration
it cannot read) is the phase-1 definition listed in §6. The `alia-kaana` relationship
needs `audio_transcriptions` terms in the grant (§5). The old pilot's
`controlledInputBudget` would refuse it exactly as it refuses realtime
(`O:services/inferenceInternalPilot.ts:104-109`).

**Capture.**

- **Web:** `MediaRecorder` with `audio/webm;codecs=opus` (Chromium, Firefox) or
  `audio/mp4` (Safari), both accepted media types. `getUserMedia` has noise
  suppression on.
- **Expo:** the `expo-audio` recorder (already a dependency; `RecordingPresets.HIGH_QUALITY`,
  m4a/AAC → `audio/mp4`), so no new native module for dictation.
- **Cap:** 5 minutes per clip, with the remaining time shown in the last 30 s. Far
  under Kaana's 20 MiB (`KC:packages/contracts/src/public/audio.ts:177-178`).

**Honest states.** `useDictation` moves through these states:

| State | Entered when |
|---|---|
| `idle` | At rest |
| `requesting-permission` | While the microphone permission is asked |
| `recording` | Only once the recorder reports it started; levels from the real recorder |
| `transcribing` | While the upload and transcription run |
| `idle` | Text inserted |
| `error { code }` | `mic-denied`, `mic-unavailable`, `too-long`, `transcription-unavailable`, `transcription-limited`, `transcription-rejected`, `transcription-failed`, `not-authenticated` |

A failed transcription keeps the clip in memory for one retry and never inserts
partial or invented text. Dictation and a call still never record together (the rule
of `docs/voice.mdx:150-152`).

## Consequences

- Calls become full duplex with server turn detection and real barge-in. Recognition
  quality stops depending on the browser or the OS, and Chrome no longer sends audio
  to Google's recognizer. **Audio now reaches Alia and Kaana and the provider.**
  `docs/voice.mdx`'s privacy section is rewritten to say so. Alia logs no audio and no
  transcript content, the rule of `K:docs/realtime.md:783`.
- Alia holds a long-lived socket per call. **Every push to `main` deploys**, so old
  tasks linger up to the 31-min drain window, running old code against an
  already-migrated schema. Calls still open at SIGTERM end with `server_shutdown`.
- One call per person is enforced in PostgreSQL. Without Redis, a takeover can
  overlap the old call by up to one lease renewal (10 s), and that overlap is billed.
- Alia sets no global concurrency or spend cap for voice. Those limits are the Alia
  app's Console policy, and **if Console leaves them unset, voice is bounded only by
  credits and the one-call rule.**
- A call costs per minute, silence included on xAI. Credits are reserved in blocks,
  and the UI can show an estimate of minutes left. Free-plan users have no calls but
  have dictation, whose cost Alia absorbs.
- The realtime model is computed, so the person's power level never makes a call
  "smarter". Hard work goes through tools that run at that level.
- Calls depend on Kaana enabling in-session input transcription. A model without it
  is not a candidate (§2).
- `@alia.onl/sdk` 14.0.0 is breaking: `useSpeechToText` is replaced by
  `useDictation`, `useVoiceRoom` changes shape and the peer
  `expo-speech-recognition` is dropped. `react-native-audio-api` becomes a native peer
  of the voice entry.
- Dictation loses live partial text and gains Firefox and consistent quality.
- One native build adds `react-native-audio-api` and removes `expo-speech-recognition`.
- ElevenLabs conversational is not usable through this design until Kaana adapts a
  raw speech-to-speech form of it. Its agent platform runs its own LLM and tools, which
  Alia's rules exclude.

## Alternatives considered

**Client ↔ Kaana directly with an ephemeral token, Alia on a side channel.**
Rejected (§1): tools would surface on the device, instructions and memory would live
in the client, Alia could not gate or charge, and Kaana has neither ephemeral tokens
nor a sideband.

**Ship sooner on the current Oxy edge (`api.oxy.so/v1/realtime`)** with a raw
WebSocket in Alia and a #1701-style `realtime` block in Oxy's pilot. Rejected by the
owner (2026-10-15):

- It adds a consumer and a pilot patch that ADR 0002 deletes.
- It gives no dictation, since the edge has no transcription.
- It inherits the edge's 16-session cap.

**Alia transcribes the person's speech itself** (slicing the forwarded PCM by
`speech_started`/`speech_stopped` and sending it to batch transcription). This was the
first draft's proposal. Rejected by the owner: Kaana enables input transcription
inside the session.

**A global cap on voice calls in Alia, or a per-session USD ceiling chosen by Alia.**
Rejected by the owner: Kaana serves the concurrency asked of it, and capacity and
spend are the app's Console policy.

**Keep the turn loop and only replace on-device recognition with Kaana
transcription.** Rejected by the owner's decision: turn detection and barge-in stay
heuristic and on the client.

**Streaming dictation through a `transcription` session.** Deferred (§7): no adapter
serves it, and it costs several times more.

**`expo-audio` `AudioStream` for calls.** Rejected (§4): no AEC source and no PCM
playback.

## Enforcement

None of these checks exists yet. Each is part of the phase that introduces the code.

- **Tools never run on the client:** an API test asserting that `/v1/voice/session`
  never sends a tool schema, an instruction or a tool result payload to the socket.
- **The owner's data:** a test that an agent session opened by someone other than its
  owner gets no `oxy_*` tools. The same matrix as the chat tests on
  `requesterAccountId`.
- **No model ids in code:** the existing rule (Alia `AGENTS.md`); the realtime and
  transcription selection tests run on fixture catalogues only.
- **Typed failures:** a test that every `KaanaError` class maps to a
  `VoiceErrorCode`, and that no failure emits audio or a text filler.
- **`expo-speech-recognition` stays removed:**
  `packages/app/__tests__/removed-dependencies-stay-removed.test.ts` gains it in
  phase 4.
- **The SDK's text entries do not load the audio engine:**
  `packages/alia-chat/scripts/check-entry-isolation.mjs` extended to
  `react-native-audio-api`.
- **The server gates `voice-mode`:** an API test that `session.start` without it
  closes with `plan-required`. A test that dictation succeeds on the free plan and
  charges no credits.
- **One call per person:** a `test:pg` test that two concurrent takeovers for one
  person leave exactly one active row (the partial unique index), and that a holder
  whose lease update touches no row hangs up with `call-moved-elsewhere`.
- **Only Alia's apps:** an API test that an `oxy_sk_` credential on
  `/v1/voice/session` is refused.
- **No capacity constants in Alia:** code review. No check prevents someone from
  adding a voice concurrency cap in Alia.
- **Honest `listening`:** an SDK test that `listening` is not entered before
  `session.created`, the first captured buffer and the first acknowledged append.
- **Real-audio validation** (Pixel 8a, iOS on a Mac, Chrome, Safari, Firefox):
  recorded in `docs/native-validation.mdx` before the phase-4 release. Code review is
  the only guard that it happened.

## Owner's answers (2026-10-15)

The first draft asked eight questions. The owner answered them, and the answers are
in the decision above:

| # | Question | Answer | Where |
|---|---|---|---|
| 1 | Timing | Directly on `@kaana.ai/sdk`; no shortcut through the current edge | §6 |
| 2 | Concurrency and ceilings | No global cap in Alia. **One active call per person**, and a new call takes over. Kaana serves the concurrency asked of it. Per-app concurrency and spend are Console policy that Oxy applies at the grant. Duration and idle time stay Alia rules | §3, §3a, §5 |
| 3 | The person's transcript | Kaana enables and charges `inputAudioTranscription` inside the session; no batch transcription in Alia | §3, §5, §6 |
| 4 | Plans | Voice on go/pro/max/ultra, credits per minute. Dictation free on every plan | §5, §7 |
| 5 | Durations | 30 min per call, 5 min per dictation clip | §3, §7 |
| 6 | Power levels | The level does not pick the realtime model | §2 |
| 7 | Third parties | `/v1/voice/session` serves Alia's own apps only at first | §3 |
| 8 | Infra | Sticky routing on the ALB and a drain window on deploys | §3b |

**Still to settle, outside Alia:**

- **Kaana's input-transcription units.** How Kaana reports the ASR audio beside the
  session's units without breaking the unit rule.
- **The Alia app's Console values** for session concurrency and spend. The values are
  Oxy's, and Console must offer the fields first (§5).

## Implementation status

Updated 2026-10-15.

| Phase | Repo | State |
|---|---|---|
| 0 | Alia | Done: this record, the note on ADR 0013, `docs/voice.mdx` rewritten. |
| 1 | Kaana | Pending: input transcription inside sessions and its catalogue flag, `audio` and `capabilities.realtime` for realtime models, the upload's measured duration. |
| 1 | Alia | **Done** (`feat/voice-realtime`): `lib/kaana/{port,transport,fake}.ts`; `lib/chat/turn-inputs.ts` (extracted from `buildChatRequestContext`); `lib/voice/` (`call.ts` the session, `tool-bridge.ts`, `turn.ts`, `credits.ts`, `call-registry.ts`, `errors.ts`, `protocol.ts`, `voice-socket.ts`, `transcribe.ts`); `lib/models/voice-models.ts`; `GET /v1/voice/session`; `POST /v1/audio/transcriptions`; migration `0094_voice_calls` (pre phase: `voice_calls`, `messages.interrupted_after_ms`). SDK 15.0.0: `useVoiceRoom` over the socket with the audio-engine seam (web `AudioWorklet`, native `react-native-audio-api`), `useDictation`. App wired. Pixel 8a validation not run (`docs/native-validation.mdx` §9). |
| 2 | Oxy | Pending. |
| 3 | Kaana / oxy-infra | Pending. |
| 4 | Alia | The deletion of on-device recognition is **done early**, with phase 1, at the owner's request (no browser or OS recognizer anywhere; `expo-speech-recognition` in `removed-dependencies-stay-removed.test.ts`). Left: the one-line switch in `lib/kaana/transport.ts`, the types from `@kaana.ai/contracts`, the release gates. Until then a call ends `realtime-unavailable` and dictation answers `TRANSCRIPTION_UNAVAILABLE`, so the app release that carries SDK 15 waits for the switch. |
| 5 | Alia | Pending. |

**Choices this record left open, made in phase 1** (the simplest coherent with it):

- `realtime.connect(open)` carries no model, which travels on the URL
  (`?model=`): the port passes it beside the frame as `model`.
- The catalogue flag for in-session input transcription is read as
  `capabilities.realtime.inputAudioTranscription` until Kaana names it.
- Turn detection is always `server_vad` (the catalogue says nothing about
  `semantic_vad`).
- A reviewed action files its card in the conversation, as in chat; the call
  UI is told (`approval.requested`) and the call does not wait on it. Tools
  that need an SSE surface (question card, plan preview, new-conversation chip)
  are not offered in a call.
- Messages of a call are appended by `seq` (`appendConversationMessages`), not
  through `saveConversation`, which reconciles a client's history the call does
  not have. The heard milliseconds of an interrupted answer are a column,
  `messages.interrupted_after_ms`, kept across a later rewrite.
- A product's agent is refused in a call (`agent-unavailable`): it is reached
  through its application's lane, which a person's socket is not.
- A resume replays the call's JSON events; assistant audio sent while the socket
  was away is not replayed.
- An unpriced realtime model is held at the initial reservation per block and
  settled at the minimum, logged (the `calculateCredits` rule).
- Dictation takes a person's session only (an `oxy_sk_` is refused); its 5-minute
  bound is the recorder's `durationMs` plus Kaana's 20 MiB, until Kaana's measured
  duration is in the grant.
- `@alia.onl/sdk` is 15.0.0, not 14.0.0: 14.0.0 had already shipped (#752).
- `react-native-audio-api` 0.13.6 has neither `iosVoiceProcessing` nor an Android
  `voiceCommunication` preset: iOS uses the `playAndRecord` session in `voiceChat`
  mode; Android's echo cancellation is the release gate of §4, with this record's
  fallback.
- During a call the app shows the thread as the server stores it
  (`messages.saved`, `conversation:message`), not a live client transcript.
