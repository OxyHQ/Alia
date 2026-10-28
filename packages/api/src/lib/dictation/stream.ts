/**
 * One streaming dictation (ADR 0024): the person's microphone, through a Kaana
 * `transcription` session, back to the device as numbered segments.
 *
 *   socket ──PCM16──▶ DictationStream ──appendAudio──▶ Kaana session ──▶ provider
 *          ◀─transcript.interim/delta/final─┘
 *
 * The model is computed from Kaana's catalogue (`rankTranscriptionSessionCandidates`)
 * and the open is tried on at most two candidates, only on a model refusal.
 * Free on every plan: no plan feature, no credits (ADR 0005); one `/v1`
 * rate-limit request at open (the socket's). Audio and text pass through and
 * are never logged: codes, durations, byte counts and model ids only.
 *
 * Kaana ends a session at once on `session.close`, so an ending first commits
 * the open segment and waits, bounded, for its `transcript.done`.
 */

import type { RealtimeServerEvent } from '@kaana.ai/contracts';
import type { RealtimeSession } from '@kaana.ai/sdk';
import { log } from '../logger.js';
import type { KaanaClient } from '../kaana/port.js';
import { rankTranscriptionSessionCandidates } from '../models/voice-models.js';
import { isModelRefusal } from '../voice/errors.js';
import {
  MAX_DICTATION_MS,
  TranscriptionError,
  transcriptionFailureForCode,
  transcriptionFailureOf,
} from '../voice/transcribe.js';
import {
  DICTATION_BYTES_PER_SECOND,
  type DictationCloseReason,
  type DictationServerEvent,
} from './protocol.js';

export interface DictationSink {
  send(event: DictationServerEvent): void;
  close(): void;
}

export interface DictationStreamLimits {
  /** The longest dictation (the batch clip's five minutes). */
  readonly maxDurationMs: number;
  /** Kaana ends a session that receives nothing for this long. */
  readonly idleTimeoutMs: number;
  /** How long an ending waits for the open segment's final text. */
  readonly finalWaitMs: number;
  /** Audio held while the session opens; what is over it is dropped. */
  readonly maxPendingBytes: number;
}

export const DICTATION_STREAM_LIMITS: DictationStreamLimits = {
  maxDurationMs: MAX_DICTATION_MS,
  idleTimeoutMs: 30_000,
  finalWaitMs: 3_000,
  maxPendingBytes: 10 * DICTATION_BYTES_PER_SECOND,
};

/** Alia's own guard beyond Kaana's ceiling, should Kaana's close not arrive. */
const DURATION_GRACE_MS = 5_000;

const CANDIDATES = 2;

/** How long a closing session may hold the per-dictation transport open. */
const DISPOSE_WAIT_MS = 5_000;

type Segment = { readonly number: number; final: boolean };

let dictationCounter = 0;

export class DictationStream {
  readonly id = `dict_${Date.now().toString(36)}_${(dictationCounter++).toString(36)}`;
  /** Settles once the dictation has ended, whatever ended it. */
  readonly ended: Promise<void>;
  private resolveEnded!: () => void;

  private session: RealtimeSession | null = null;
  private model: string | null = null;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private droppedPending = false;
  private sentBytes = 0;
  private readonly segments = new Map<string, Segment>();
  private nextSegment = 0;
  private finalWaiters: Array<() => void> = [];
  private ending = false;
  private finished = false;
  private readonly openedAt = Date.now();
  private guard: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly kaana: KaanaClient | null,
    private readonly oxyUserId: string,
    private readonly sink: DictationSink,
    private readonly limits: DictationStreamLimits = DICTATION_STREAM_LIMITS,
  ) {
    this.ended = new Promise((resolve) => {
      this.resolveEnded = resolve;
    });
  }

  /** Open the Kaana session on the first candidate that does not refuse it. */
  async open(language: string | undefined): Promise<void> {
    try {
      const kaana = this.kaana;
      if (!kaana) throw new TranscriptionError('TRANSCRIPTION_UNAVAILABLE');
      const models = await kaana.models
        .list({ onBehalfOfUserId: this.oxyUserId })
        .catch((error: unknown) => {
          throw transcriptionFailureOf(error);
        });
      const candidates = rankTranscriptionSessionCandidates(models).slice(0, CANDIDATES);
      if (candidates.length === 0) throw new TranscriptionError('TRANSCRIPTION_UNAVAILABLE');
      for (const [index, candidate] of candidates.entries()) {
        if (this.finished) return;
        try {
          this.session = await kaana.realtime.connect(
            {
              model: candidate.model.modelId,
              type: 'session.open',
              kind: 'transcription',
              transport: 'websocket',
              config: {
                inputAudioFormat: 'pcm16_24khz',
                turnDetection: {
                  type: 'server_vad',
                  createResponse: false,
                  interruptResponse: false,
                },
                inputAudioTranscription: {
                  ...(language === undefined ? {} : { language }),
                  interimResults: true,
                },
              },
              limits: {
                maxDurationMs: this.limits.maxDurationMs,
                idleTimeoutMs: Math.min(this.limits.idleTimeoutMs, this.limits.maxDurationMs),
                maxInputAudioBytes: Math.ceil(
                  (this.limits.maxDurationMs * DICTATION_BYTES_PER_SECOND) / 1000,
                ),
                maxOutputAudioBytes: 1,
                maxResponses: 1,
              },
              clientSessionId: this.id,
              labels: { surface: 'alia-dictation' },
            },
            { onBehalfOfUserId: this.oxyUserId },
          );
          this.model = candidate.model.modelId;
          break;
        } catch (error) {
          if (index < candidates.length - 1 && isModelRefusal(error)) {
            log.voice.warn(
              { model: candidate.model.modelId, dictationId: this.id },
              'Transcription model refused the dictation; trying the next candidate',
            );
            continue;
          }
          throw transcriptionFailureOf(error);
        }
      }
      const session = this.session;
      if (!session) throw new TranscriptionError('TRANSCRIPTION_UNAVAILABLE');
      if (this.finished) {
        void session.close().catch(() => undefined);
        return;
      }
      this.guard = setTimeout(
        () => void this.finish('max-duration'),
        this.limits.maxDurationMs + DURATION_GRACE_MS,
      );
      this.guard.unref?.();
      this.sink.send({ type: 'dictation.ready', maxDurationMs: this.limits.maxDurationMs });
      log.voice.info({ dictationId: this.id, model: this.model }, 'Dictation opened');
      for (const frame of this.pending) this.forward(session, frame);
      this.pending = [];
      this.pendingBytes = 0;
      void this.pump(session);
      if (this.ending) void this.endSession(session);
    } catch (error) {
      await this.finish('error', transcriptionFailureOf(error));
    }
  }

  /** One microphone frame, PCM16 24 kHz mono. */
  audio(pcm: Uint8Array): void {
    if (this.finished || this.ending || pcm.byteLength === 0) return;
    const session = this.session;
    if (session) {
      this.forward(session, pcm);
      return;
    }
    if (this.pendingBytes + pcm.byteLength > this.limits.maxPendingBytes) {
      if (!this.droppedPending)
        log.voice.warn(
          { dictationId: this.id },
          'Dictation audio dropped while the session opened',
        );
      this.droppedPending = true;
      return;
    }
    this.pending.push(pcm.slice());
    this.pendingBytes += pcm.byteLength;
  }

  /** End the current segment now (push-to-talk). */
  commit(): void {
    if (this.finished || this.ending || !this.session) return;
    this.command({ type: 'input_audio.commit' });
  }

  /** No more audio: the open segment's final text, then the session ends. */
  async end(): Promise<void> {
    if (this.finished || this.ending) return this.ended;
    this.ending = true;
    if (this.session) await this.endSession(this.session);
    return this.ended;
  }

  /** The device left or the task is shutting down: nothing more is sent to it. */
  async abort(reason: 'client-gone' | 'server-shutdown'): Promise<void> {
    await this.finish(reason, undefined, { silent: reason !== 'server-shutdown' });
  }

  private async endSession(session: RealtimeSession): Promise<void> {
    if (this.openSegment()) {
      this.command({ type: 'input_audio.commit' });
      await this.untilFinal(this.limits.finalWaitMs);
    }
    if (this.finished) return;
    await session.close().catch(() => undefined);
    await this.finish('ended');
  }

  private forward(session: RealtimeSession, pcm: Uint8Array): void {
    try {
      session.appendAudio(pcm);
      this.sentBytes += pcm.byteLength;
    } catch (error) {
      log.voice.warn({ err: error, dictationId: this.id }, 'Dictation audio not sent upstream');
    }
  }

  private command(body: { readonly type: 'input_audio.commit' }): void {
    try {
      this.session?.send(body);
    } catch (error) {
      log.voice.warn({ err: error, dictationId: this.id }, 'Dictation command not sent upstream');
    }
  }

  private openSegment(): boolean {
    for (const segment of this.segments.values()) if (!segment.final) return true;
    return false;
  }

  private untilFinal(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.finalWaiters.push(done);
    });
  }

  private segmentOf(itemId: string): Segment {
    let segment = this.segments.get(itemId);
    if (!segment) {
      segment = { number: this.nextSegment++, final: false };
      this.segments.set(itemId, segment);
    }
    return segment;
  }

  private async pump(session: RealtimeSession): Promise<void> {
    try {
      for await (const event of session) {
        if (this.finished) return;
        if (event.type === 'session.closed') {
          await this.onClosed(event.reason);
          return;
        }
        this.handle(event);
      }
    } catch (error) {
      if (this.finished) return;
      try {
        await session.resume();
        if (!this.finished) void this.pump(session);
        return;
      } catch {
        await this.finish('error', transcriptionFailureOf(error));
      }
    }
  }

  private handle(event: RealtimeServerEvent): void {
    switch (event.type) {
      case 'transcript.interim': {
        const segment = this.segmentOf(event.itemId);
        if (!segment.final)
          this.sink.send({ type: 'transcript.interim', segment: segment.number, text: event.text });
        return;
      }
      case 'transcript.delta': {
        if (event.source !== 'input_audio') return;
        const segment = this.segmentOf(event.itemId);
        if (!segment.final)
          this.sink.send({ type: 'transcript.delta', segment: segment.number, text: event.text });
        return;
      }
      case 'transcript.done': {
        if (event.source !== 'input_audio') return;
        const segment = this.segmentOf(event.itemId);
        if (segment.final) return;
        segment.final = true;
        this.sink.send({
          type: 'transcript.final',
          segment: segment.number,
          text: event.transcript.trim(),
        });
        if (!this.openSegment()) {
          const waiters = this.finalWaiters;
          this.finalWaiters = [];
          for (const resolve of waiters) resolve();
        }
        return;
      }
      case 'error': {
        if (event.fatal) {
          void this.finish(
            'error',
            transcriptionFailureForCode(event.error.code, { retryable: event.error.retryable }),
          );
          return;
        }
        log.voice.warn(
          { dictationId: this.id, code: event.error.code, param: event.error.param ?? null },
          'Kaana refused a dictation command',
        );
        return;
      }
      default:
        return;
    }
  }

  private async onClosed(reason: string): Promise<void> {
    switch (reason) {
      case 'client_closed':
        await this.finish('ended');
        return;
      case 'max_duration':
        await this.finish('max-duration');
        return;
      case 'idle_timeout':
        await this.finish('idle-timeout');
        return;
      case 'limit_exceeded':
        await this.finish('error', new TranscriptionError('CLIP_TOO_LONG'));
        return;
      default:
        await this.finish(
          'error',
          new TranscriptionError('TRANSCRIPTION_FAILED', { retryable: true }),
        );
    }
  }

  private async finish(
    reason: DictationCloseReason | 'client-gone',
    failure?: TranscriptionError,
    options: { silent?: boolean } = {},
  ): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.guard) clearTimeout(this.guard);
    const waiters = this.finalWaiters;
    this.finalWaiters = [];
    for (const resolve of waiters) resolve();
    const session = this.session;
    const closing = session
      ? session.close().then(
          () => undefined,
          () => undefined,
        )
      : null;
    if (!options.silent) {
      if (failure)
        this.sink.send({
          type: 'error',
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        });
      this.sink.send({
        type: 'dictation.closed',
        reason: failure || reason === 'client-gone' ? 'error' : reason,
      });
      this.sink.close();
    }
    const fields = {
      dictationId: this.id,
      model: this.model,
      reason: failure ? 'error' : reason,
      code: failure?.code ?? null,
      segments: this.segments.size,
      audioMs: Math.round((this.sentBytes * 1000) / DICTATION_BYTES_PER_SECOND),
      durationMs: Date.now() - this.openedAt,
    };
    if (failure) log.voice.warn(fields, 'Dictation failed');
    else log.voice.info(fields, 'Dictation closed');
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      this.kaana?.dispose?.();
    };
    if (closing) {
      const bound = setTimeout(dispose, DISPOSE_WAIT_MS);
      bound.unref?.();
      void closing.then(() => {
        clearTimeout(bound);
        dispose();
      });
    } else dispose();
    this.resolveEnded();
  }
}
