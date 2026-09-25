# ADR 0012: Voice runs on the device; LiveKit, cohost and voice minutes are retired

## Status

Accepted

## Date

2026-09-24

## Context

Issue #608 §9 made a working call mode a blocking requirement of the Bloom
refactor, and two of its items fixed the call's shape: "Mantener LiveKit/WebRTC y
la integración SDK como transporte" and "Conservar cohost: activar/desactivar,
identificación del speaker, fin de ronda y continuar". §10 adds that retiring a
capability "requiere una decisión de producto separada y explícita, no una
omisión en el refactor". This record is that decision; the product owner made
it and shipped it on 2026-09-24.

What forced it ([Voice](../voice.mdx), § Why it is built this way):

- Until #477, dictation posted audio to `POST /v1/voice/transcribe` and a call
  opened a LiveKit room from `POST /v1/voice/token`. Both reached speech
  providers directly.
- Alia's only inference path is `Alia -> Oxy -> Kaana`
  ([ADR 0001](./0001-alia-oxy-kaana-responsibility-boundary.md)). Oxy serves chat
  and speech synthesis, but **no transcription and no realtime session**. From
  the cut-over (#477) both routes answered `503`, so neither dictation nor calls
  worked at all.
- Putting transcription and a realtime session into Oxy and Kaana is
  cross-repository work. Recognizing speech on the device needs none of it.

## Decision

1. **The device listens.** Speech recognition runs on the device behind one
   contract with two engines. On the web it is the Web Speech API
   (`packages/alia-chat/src/lib/speech-recognition.ts`). On iOS and Android it
   is `expo-speech-recognition` (`speech-recognition.native.ts`). No audio
   reaches Alia. Firefox has no engine, and dictation and calls say they are
   unsupported there instead of failing.
2. **A call is a loop of chat turns.** `useVoiceRoom` (`@alia.onl/sdk/voice`,
   8.0.0) closes an utterance on silence and sends it as a turn. In the app,
   `use-voice-mode.ts` sends each utterance through the conversation screen's
   own `sendMessage`: `POST /alia/chat` with `responseMode: "voice"`, the open
   conversation, its agent, the chosen model and every tool. A call's turns are
   ordinary messages of that conversation, and the server persists them.
3. **Oxy speaks.** The answer is synthesized sentence by sentence through
   `POST /v1/audio/speech`, the same route read-aloud uses. Talking over the
   answer aborts playback and the request (barge-in).
4. **Retired with the LiveKit room:**
   - **The LiveKit/WebRTC transport.** `livekit-client` left the SDK's peers.
     The app lost `@livekit/react-native`, `@livekit/react-native-webrtc`, the
     Expo plugin and `registerGlobals` (commit `621ea5e5`). The two `/v1/voice`
     routes were removed (`38c019e7`). Alia also stopped syncing
     `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` in `deploy-aws.yml` (`5e7bd123`).
   - **Cohost**, the second realtime voice in the LiveKit room. The
     `voice-cohost` feature is no longer seeded or shown on pricing. The app's
     cohost handlers, the message `speaker` field and the "Cohost" label are
     gone (`5e7bd123`). The SDK dropped its cohost surface (`a8630e26`).
   - **The `voice-minutes` allowance.** It was an Alia-local count of LiveKit
     minutes in `voice_call_usage`, and its only writer was the LiveKit route,
     so it enforced nothing. `reserveVoiceCredits`/`finalizeVoiceCredits`,
     `voice_call_usage` and `GET /billing/voice-usage` are removed.
   Migration `0074_voice_minutes_retired` (post phase) deletes the
   `voice-minutes` and `voice-cohost` feature rows and drops `voice_call_usage`
   (`036c8be1`, extended by `5e7bd123`). [Voice](../voice.mdx) records the result
   (`ddc6ca6f`).
5. **Kept:** the `voice-mode` plan capability that gates calls, dictation
   (`useSpeechToText`), read-aloud (`useTTS`), and the ambient field's response
   to capture and playback levels (`useVoiceRoom().room` is a
   `VoiceLevelSource`). Each voice turn and each spoken sentence is billed by
   Oxy per request like any other
   ([ADR 0005](./0005-product-entitlements-versus-financial-ledger.md)).

This supersedes the two #608 §9 items quoted above: calls do not use
LiveKit/WebRTC, and cohost is not kept. The rest of §9 still applies to the
on-device loop: session and controls, transcript integrity, resource cleanup,
call/dictation/TTS coordination, plan limits, SDK entry isolation and real-audio
validation.

## Consequences

- Dictation and calls work again without any new capability in Oxy or Kaana.
- **A new native build is required**: `expo-speech-recognition` is a native
  module, and its config plugin writes the microphone and speech-recognition
  permission strings (`app.json`).
- Recognition quality and privacy depend on the platform. Chrome's Web Speech API
  streams audio to a Google service. Safari and iOS use Apple's recognizer,
  Android uses the device's. [Voice](../voice.mdx) says this to users of the docs
  plainly, and Alia cannot improve it.
- A call is half-duplex over HTTP rather than a realtime media session. Latency
  is one chat turn plus the first synthesized sentence, and echo rejection is
  heuristic (`isInterruption`, `packages/alia-chat/src/lib/voice-text.ts`).
- One voice per call. A two-voice mode would have to be designed again on top
  of the turn loop; nothing of cohost is left to restore.
- `@alia.onl/sdk` went to 8.0.0 (breaking). Product voices are `male | female`
  (`echo`/`nova` removed). `useVoiceRoom` no longer returns `cohostActive`,
  `roundComplete` or the cohost handlers, and `VoiceControls` lost its cohost
  props and buttons (`a8630e26`).
- Nothing measures minutes of voice any more. A per-plan voice limit, if one is
  wanted, has to be built on Oxy-recorded usage (ADR 0005), not on an Alia count.

## Alternatives considered

- **Keep LiveKit and add transcription and a realtime session to Oxy and
  Kaana.** Not chosen: cross-repository work, while voice had been fully
  unavailable since #477. It is not excluded for the future, and would need
  its own ADR.
- **Keep LiveKit with direct provider credentials in Alia.** Rejected by
  ADR 0001: Alia holds no provider credentials and has no alternative transport.
- **Keep `voice-minutes` with a new on-device writer.** Rejected by ADR 0005:
  allowances are consumed against usage Oxy records, not against a separate
  Alia count.

## Enforcement

- LiveKit stays out of the app:
  `packages/app/__tests__/removed-dependencies-stay-removed.test.ts`
  (`livekit-client`, `@livekit/react-native`, `@livekit/react-native-webrtc`,
  `@livekit/react-native-expo-plugin`).
- The SDK's text entries do not reach a retired voice module:
  `packages/alia-chat/scripts/check-entry-isolation.mjs`.
- No table persists the voice funding source:
  `packages/api/src/__tests__/billingSeparation.test.ts`.
- No check prevents `voice-cohost` or `voice-minutes` from being seeded again in
  `seed-features.ts`. Code review is the only guard.
