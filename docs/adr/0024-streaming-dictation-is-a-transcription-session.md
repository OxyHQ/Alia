# 24. Streaming dictation is a transcription session through Kaana

Status: Proposed (2026-10-28). It depends on Kaana ADR 0006 (proposed). Nothing here is
implemented.
Date: 2026-10-28.

## Context

Dictation (ADR 0017 §7) is batch: `POST /v1/audio/transcriptions` takes one clip and answers its
text (`packages/api/src/routes/v1/audio.ts`, `lib/voice/transcribe.ts`). It has run in production
since 2026-10-16 on `alia-kaana`'s `audio_transcriptions` terms (300 000 ms, USD 0.05 a request).
The composer shows nothing until the person stops.

Astro wants Dia's live dictation. It cuts the recording at pauses and posts each phrase, so text
arrives phrase by phrase. Each phrase is a request against the `/v1` rate limit (20 a minute on
the free plan, shared with chat) and a grant against `alia-kaana`'s 5 000 requests a UTC day,
which all of Alia's inference shares.

Kaana ADR 0006 proposes a `transcription` realtime session that sends locked text as
`transcript.delta`, the utterance as `transcript.done`, and, when asked, a revisable
`transcript.interim` about every 500 ms. A new client-facing surface is an ADR here
(`docs/adr/README.md`).

## Decision

1. **Route.** A new `WebSocketRoute` serves `GET /v1/audio/transcriptions/stream`, registered in
   `lib/websocket-upgrades.ts` like the voice socket and never as another `server.on('upgrade')`.
   Only a person's session is accepted. An `oxy_sk_` is refused with `credential-not-supported`,
   as for batch.
2. **Protocol 1** (`lib/dictation/protocol.ts`, copied into the SDK and checked by
   `DICTATION_PROTOCOL_VERSION` as the voice protocol is):

   ```text
   client: auth { token }
   client: dictation.start { protocol: 1, language?, sampleRate: 24000 }
   alia:   dictation.ready { maxDurationMs }
   client: <binary PCM16 mono at sampleRate, ~40-100 ms frames>
   alia:   transcript.interim { segment, text }   replaces the segment's previous interim
   alia:   transcript.delta { segment, text }     appends locked text
   alia:   transcript.final { segment, text }     the segment's final text; nothing follows for it
   client: dictation.commit                       end the current segment now (push-to-talk)
   client: dictation.end                          no more audio; alia flushes, then closes
   alia:   error { code, retryable }, dictation.closed { reason }
   ```

   Segments are Alia's numbers in order, so the device never sees Kaana item ids. A
   `transcript.final` is the only text a client keeps; interim and delta text are display state.
3. **The Kaana session.** It is opened through `lib/kaana/transport.ts` with the person as
   `onBehalfOfUserId`: `kind: transcription`, `inputAudioFormat: pcm16_24khz`,
   `inputAudioTranscription { language, interimResults: true }`, and `turnDetection: server_vad`
   with `createResponse: false, interruptResponse: false` and no `silenceDurationMs`, so Kaana's
   default applies. Limits are product rules: 5 minutes, 30 s idle, and the bytes of 5 minutes of
   24 kHz PCM16. The model is computed, never named: the cheapest catalogue line by
   `pricePerMinute` whose `capabilities.realtime.sessionKinds` includes `transcription`, with its
   language listed or detection declared. The open is tried on at most two candidates, and only
   on a model refusal, as calls do.
4. **Cost.** Free on every plan, the same as batch. There is no plan feature and no credits; the
   cost is Alia's internal cost centre (ADR 0005). One dictation is one Kaana grant and counts as
   one `/v1` rate-limit request at open. Its concurrency is the Alia application's
   `max_concurrent_realtime_sessions` in Console, shared with calls.
5. **Failure.** The answers are typed: `TRANSCRIPTION_UNAVAILABLE` (no candidate, the kind not
   granted, Kaana unavailable), `TRANSCRIPTION_LIMITED`, `TRANSCRIPTION_REJECTED`,
   `TRANSCRIPTION_FAILED`, `CLIP_TOO_LONG`. Text is never invented or kept after a failure.
   Segments already final stay final.
6. **The SDK.** `@alia.onl/sdk/dictation` gains `openDictationStream({ apiUrl, transport | token,
   language, onEvent, signal })` beside `requestTranscription` (SDK 22.6.0). It takes PCM frames
   from the caller's recorder and reaches no React or native module. `useDictation` adopts it on
   web and native, with batch as its fallback.
7. **Fallback.** While Kaana grants no `transcription` session, or when the stream refuses with
   `TRANSCRIPTION_UNAVAILABLE` at open, clients use batch `POST /v1/audio/transcriptions`.
   Astro keeps its phrase-chunked path for exactly this.
8. **Nothing is stored.** Audio and text pass through and are not logged. Logs carry codes,
   durations and model ids only (ADR 0017, Privacy).

## Consequences

- Words appear about every 500 ms. One dictation is one grant and one rate-limit request instead
  of one per phrase.
- Two dictation paths exist until every client streams. Batch stays as the fallback and for
  recorded clips.
- Streaming lists at USD 0.20 an hour against batch's 0.10. A 5-minute dictation is at most about
  USD 0.017, inside the per-minute ceiling of `alia-kaana`'s realtime terms once Oxy adds the
  `transcription` kind.
- Deployment order: Kaana ADR 0006's rollout and its canary; then Oxy adds `transcription` to
  `alia-kaana`'s `realtime.sessionKinds` (owner approval); then this route; then the SDK release;
  then clients.

## Alternatives considered

- **Relay Kaana's public session to the device.** Rejected: the device would hold a Kaana
  session under Alia's service authority. Calls keep Kaana behind Alia for the same reason
  (ADR 0017).
- **Each client opens its own Kaana session with a product-session lane.** Rejected for now:
  Astro's `product_session` terms are `responses` only (Oxy ADR 0050). Granting each app
  transcription terms of its own is an Oxy decision per app. Alia's surface already exists for
  Oxy apps' dictation.
- **Phrase-chunked batch as the product.** Kept as the fallback. Its grant count and latency are
  why this ADR exists.

## Enforcement

None exists yet. When implemented: the route is a `WebSocketRoute` (`test:bun-runtime`), the
protocol version check (a test like `voice-protocol.test.ts`), a test that a `transcript.final` is
the only text kept, and `check:entries` holding `@alia.onl/sdk/dictation` free of React and native
modules (since SDK 22.6.0).
