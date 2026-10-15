/**
 * A Kaana that speaks `@kaana.ai/contracts` 4.0.0 and runs in process.
 *
 * Two uses, one implementation:
 *
 * - **Tests** drive it by hand: `session.emit(...)` pushes a server event
 *   (numbered and stamped like Kaana's), `session.sent` records every command
 *   Alia sent, `failConnect`/`failTranscription` refuse with a typed error, and
 *   `dropConnection()` ends the upstream socket the way a network loss would.
 * - **Development** (`kaana/transport.ts`, `ALIA_VOICE_FAKE_UPSTREAM=1`) runs
 *   it `scripted`: a small energy detector over the appended PCM plays the
 *   provider — speech started/stopped, an input transcript, a spoken answer (a
 *   tone) with its transcript, interruption when the person talks over it — so
 *   the app's capture, playback and echo cancellation can be checked on a real
 *   device.
 *
 * It enforces what the contract enforces at open (instructions ≤ 32 768
 * characters, ≤ 128 tools with unique names, a voice and an output format for
 * spoken responses, an idle timeout no longer than the session, the model's
 * voices), so a test that passes against it is not passing against a looser
 * Kaana than the real one. Model ids here are fixtures (`fake/...`), never a
 * real model's name.
 */

import { randomUUID } from 'node:crypto';
import {
  KAANA_MAX_REALTIME_INSTRUCTIONS,
  KAANA_MAX_REALTIME_TOOLS,
  type KaanaClient,
  type KaanaErrorFields,
  type KaanaModel,
  type KaanaPublicErrorCode,
  type KaanaRealtimeClientEvent,
  type KaanaRealtimeConnectRequest,
  type KaanaRealtimeServerEvent,
  type KaanaRealtimeSession,
  type KaanaRealtimeSessionLimits,
  type KaanaRequestOptions,
  type KaanaTranscription,
  type KaanaTranscriptionRequest,
  type KaanaUsage,
} from './port.js';

/* -------------------------------------------------------------------------- */
/*  Typed errors, shaped like the SDK's                                        */
/* -------------------------------------------------------------------------- */

const CLASS_OF: Record<KaanaPublicErrorCode, string> = {
  authentication_failed: 'KaanaAuthenticationError',
  permission_denied: 'KaanaPermissionError',
  insufficient_scope: 'KaanaPermissionError',
  commercial_permission_denied: 'KaanaPermissionError',
  policy_violation: 'KaanaPermissionError',
  invalid_request: 'KaanaInvalidRequestError',
  model_not_found: 'KaanaInvalidRequestError',
  unsupported_modality: 'KaanaInvalidRequestError',
  context_length_exceeded: 'KaanaInvalidRequestError',
  request_too_large: 'KaanaInvalidRequestError',
  output_limit_exceeded: 'KaanaInvalidRequestError',
  idempotency_conflict: 'KaanaInvalidRequestError',
  byok_credential_invalid: 'KaanaInvalidRequestError',
  insufficient_balance: 'KaanaBillingError',
  spending_limit_exceeded: 'KaanaBillingError',
  quota_exceeded: 'KaanaBillingError',
  rate_limited: 'KaanaRateLimitError',
  no_route_available: 'KaanaUnavailableError',
  service_unavailable: 'KaanaUnavailableError',
  provider_error: 'KaanaUnavailableError',
  provider_timeout: 'KaanaUnavailableError',
  provider_overloaded: 'KaanaUnavailableError',
  upstream_content_filtered: 'KaanaContentFilteredError',
  cancelled: 'KaanaCancelledError',
  internal_error: 'KaanaInternalError',
};

const RETRYABLE: ReadonlySet<KaanaPublicErrorCode> = new Set([
  'rate_limited',
  'provider_error',
  'provider_timeout',
  'provider_overloaded',
  'service_unavailable',
  'internal_error',
]);

/** A `KaanaError` as the SDK throws it: the subclass's name and the public fields. */
export class FakeKaanaError extends Error implements KaanaErrorFields {
  readonly code: KaanaPublicErrorCode;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly param?: string;
  readonly afterOutput: boolean;

  constructor(
    code: KaanaPublicErrorCode,
    options: { param?: string; retryAfterMs?: number; afterOutput?: boolean } = {},
  ) {
    super(`fake ${code}`);
    this.name = CLASS_OF[code];
    this.code = code;
    this.status = null;
    this.requestId = `req_fake_${randomUUID()}`;
    this.retryable = RETRYABLE.has(code);
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.param !== undefined) this.param = options.param;
    this.afterOutput = options.afterOutput ?? false;
  }
}

/** `KaanaConnectionError`: no response at all. */
export class FakeKaanaConnectionError extends Error {
  readonly timedOut: boolean;
  constructor(timedOut = false) {
    super('fake connection lost');
    this.name = 'KaanaConnectionError';
    this.timedOut = timedOut;
  }
}

/* -------------------------------------------------------------------------- */
/*  Fixture catalogue                                                          */
/* -------------------------------------------------------------------------- */

const PRICE_VERSION = 'fake-price-1';

/** A realtime speech-to-speech model as the catalogue publishes one. */
export function fakeRealtimeModel(overrides: Partial<KaanaModel> = {}): KaanaModel {
  return {
    schemaVersion: 1,
    modelId: 'fake/realtime-voice',
    publisher: { slug: 'fake', displayName: 'Fake Labs' },
    displayName: 'Fake Realtime Voice',
    currentRevision: '2026-10-01',
    capabilities: {
      inputModalities: ['audio', 'text'],
      outputModalities: ['audio', 'text'],
      tools: true,
      realtime: {
        transports: ['websocket'],
        sessionKinds: ['conversation'],
        inputAudioTranscription: true,
      },
    },
    audio: {
      voices: [
        { id: 'fake-voice-a', name: 'Ana', languages: ['en', 'es'], gender: 'female' },
        { id: 'fake-voice-b', name: 'Bruno', languages: ['en', 'es'], gender: 'male' },
      ],
      languages: ['en', 'es'],
      audioFormats: { input: ['audio/pcm'], output: ['audio/pcm'] },
    },
    releasedAt: '2026-10-01T00:00:00Z',
    pricing: {
      priceVersionId: PRICE_VERSION,
      currency: 'USD',
      unitPrices: [{ unit: 'session_milliseconds', amount: '0.08', per: 60_000, currency: 'USD' }],
    },
    deprecation: { status: 'active' },
    ...overrides,
  };
}

/** A batch transcription model. */
export function fakeTranscriptionModel(overrides: Partial<KaanaModel> = {}): KaanaModel {
  return {
    schemaVersion: 1,
    modelId: 'fake/transcribe',
    publisher: { slug: 'fake', displayName: 'Fake Labs' },
    displayName: 'Fake Transcribe',
    currentRevision: '2026-09-01',
    capabilities: {
      inputModalities: ['audio'],
      outputModalities: ['text'],
      tools: false,
      apiFormats: ['audio_transcriptions'],
    },
    audio: {
      voices: [],
      languages: ['en', 'es', 'fr'],
      audioFormats: { input: ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav'], output: [] },
    },
    pricing: {
      priceVersionId: PRICE_VERSION,
      currency: 'USD',
      unitPrices: [
        { unit: 'audio_input_milliseconds', amount: '0.006', per: 60_000, currency: 'USD' },
      ],
    },
    deprecation: { status: 'active' },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  The realtime session                                                       */
/* -------------------------------------------------------------------------- */

const DEFAULT_LIMITS: KaanaRealtimeSessionLimits = {
  maxDurationMs: 600_000,
  idleTimeoutMs: 120_000,
  maxInputAudioBytes: 28_800_000,
  maxOutputAudioBytes: 28_800_000,
  maxResponses: 20,
};

type EventBody = KaanaRealtimeServerEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'schemaVersion' | 'requestId' | 'sequence'>
    : never
  : never;

export class FakeRealtimeSession implements KaanaRealtimeSession {
  readonly sessionId = `rts_fake_${randomUUID()}`;
  readonly requestId = `req_fake_${randomUUID()}`;
  /** Every command Alia sent, in order. */
  readonly sent: KaanaRealtimeClientEvent[] = [];
  /** Bytes of PCM appended. */
  appendedBytes = 0;
  appendCount = 0;
  resumeCount = 0;
  closeCount = 0;
  /** When set, the next `resume()` rejects. */
  failResume = false;
  /** The units `close()` reports, unless a test emits its own `session.closed`. */
  closeUnits: KaanaUsage = [];

  private sequence = 0;
  private readonly queue: KaanaRealtimeServerEvent[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;
  private broken: Error | null = null;
  private closing: Promise<KaanaUsage> | null = null;
  private readonly scripted: FakeScript | null;

  constructor(
    readonly request: KaanaRealtimeConnectRequest,
    readonly options: KaanaRequestOptions | undefined,
    scripted: boolean,
  ) {
    this.scripted = scripted ? new FakeScript(this) : null;
  }

  /** Push a server event, numbered as Kaana numbers them. */
  emit(event: EventBody): void {
    if (this.ended) return;
    const full = {
      schemaVersion: 1,
      requestId: this.requestId,
      sequence: this.sequence++,
      ...event,
    } as KaanaRealtimeServerEvent;
    this.queue.push(full);
    if (full.type === 'session.closed') this.ended = true;
    this.wake();
  }

  /** The upstream socket goes away without a `session.closed`. */
  dropConnection(): void {
    this.broken = new FakeKaanaConnectionError();
    this.wake();
  }

  send(event: KaanaRealtimeClientEvent): void {
    if (this.ended) throw new FakeKaanaError('invalid_request', { param: 'session' });
    this.sent.push(event);
    this.scripted?.onCommand(event);
  }

  appendAudio(pcm16: Uint8Array): void {
    if (this.ended) throw new FakeKaanaError('invalid_request', { param: 'session' });
    if (pcm16.byteLength > 49_152) throw new FakeKaanaError('request_too_large');
    this.appendedBytes += pcm16.byteLength;
    this.appendCount += 1;
    this.scripted?.onAudio(pcm16);
  }

  async resume(): Promise<void> {
    this.resumeCount += 1;
    if (this.failResume || this.ended) throw new FakeKaanaError('invalid_request');
    this.broken = null;
    this.emit({ type: 'session.resumed', afterSequence: this.sequence - 1 });
  }

  close(): Promise<KaanaUsage> {
    this.closeCount += 1;
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.scripted?.stop();
      if (!this.ended) {
        this.emit({
          type: 'session.closed',
          reason: 'client_closed',
          units: this.closeUnits,
          usageSource: 'provider_reported',
          closedAt: new Date().toISOString(),
        });
      }
      return this.closeUnits;
    })();
    return this.closing;
  }

  /** The commands of one type, for assertions. */
  commands<T extends KaanaRealtimeClientEvent['type']>(
    type: T,
  ): Array<Extract<KaanaRealtimeClientEvent, { type: T }>> {
    return this.sent.filter((event) => event.type === type) as Array<
      Extract<KaanaRealtimeClientEvent, { type: T }>
    >;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<KaanaRealtimeServerEvent> {
    for (;;) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        if (next.type === 'session.closed') return;
        continue;
      }
      if (this.broken !== null) {
        const error = this.broken;
        this.broken = null;
        throw error;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }
}

/* -------------------------------------------------------------------------- */
/*  The scripted provider (development)                                        */
/* -------------------------------------------------------------------------- */

/** RMS over PCM16, 0..1. */
function rms(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.byteLength / 2);
  if (samples === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const value = view.getInt16(i * 2, true) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

/** A 440 Hz tone, PCM16 24 kHz, `ms` long. */
function tone(ms: number): Uint8Array {
  const samples = Math.round((24_000 * ms) / 1000);
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i++) {
    view.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / 24_000) * 6000), true);
  }
  return pcm;
}

const SPEECH_RMS = 0.02;
const SPEECH_START_MS = 200;
const SILENCE_END_MS = 700;
const FRAME_MS = 40;

class FakeScript {
  private loudMs = 0;
  private quietMs = 0;
  private speaking = false;
  private heardMs = 0;
  private turn = 0;
  private responding: { responseId: string; itemId: string; timer: NodeJS.Timeout } | null = null;
  private stopped = false;

  constructor(private readonly session: FakeRealtimeSession) {}

  stop(): void {
    this.stopped = true;
    if (this.responding) clearInterval(this.responding.timer);
    this.responding = null;
  }

  onCommand(event: KaanaRealtimeClientEvent): void {
    if (event.type === 'response.create') this.respond();
  }

  onAudio(pcm: Uint8Array): void {
    if (this.stopped) return;
    const ms = pcm.byteLength / 48;
    const loud = rms(pcm) >= SPEECH_RMS;
    if (loud) {
      this.loudMs += ms;
      this.quietMs = 0;
    } else {
      this.quietMs += ms;
      if (!this.speaking) this.loudMs = 0;
    }
    if (!this.speaking && this.loudMs >= SPEECH_START_MS) {
      this.speaking = true;
      this.heardMs = 0;
      this.turn += 1;
      this.session.emit({
        type: 'input_audio.speech_started',
        itemId: `item_user_${this.turn}`,
        audioStartMs: 0,
      });
      if (this.responding) this.cancel();
    }
    if (this.speaking) this.heardMs += ms;
    if (this.speaking && this.quietMs >= SILENCE_END_MS) {
      this.speaking = false;
      this.loudMs = 0;
      const itemId = `item_user_${this.turn}`;
      this.session.emit({ type: 'input_audio.speech_stopped', itemId, audioEndMs: 0 });
      this.session.emit({ type: 'input_audio.committed', itemId });
      this.session.emit({
        type: 'transcript.done',
        source: 'input_audio',
        itemId,
        contentIndex: 0,
        transcript: `(fake) ${Math.round(this.heardMs / 100) / 10} s of speech`,
      });
      this.respond();
    }
  }

  private cancel(): void {
    const responding = this.responding;
    if (!responding) return;
    clearInterval(responding.timer);
    this.responding = null;
    this.session.emit({
      type: 'response.done',
      responseId: responding.responseId,
      status: 'cancelled',
      units: [{ unit: 'audio_output_tokens', quantity: 10 }],
      usageSource: 'provider_reported',
    });
  }

  private respond(): void {
    if (this.stopped || this.responding) return;
    const responseId = `resp_fake_${this.turn}_${randomUUID().slice(0, 8)}`;
    const itemId = `item_assistant_${this.turn}_${randomUUID().slice(0, 8)}`;
    const answer = `You spoke for about ${Math.max(1, Math.round(this.heardMs / 1000))} seconds.`;
    this.session.emit({ type: 'response.created', responseId });
    const frames = Math.round(1_600 / FRAME_MS);
    let sent = 0;
    const timer = setInterval(() => {
      if (sent < frames) {
        this.session.emit({
          type: 'output_audio.delta',
          responseId,
          itemId,
          contentIndex: 0,
          format: 'pcm16_24khz',
          data: Buffer.from(tone(FRAME_MS)).toString('base64'),
        });
        if (sent === 0)
          this.session.emit({
            type: 'transcript.delta',
            source: 'output_audio',
            itemId,
            contentIndex: 0,
            responseId,
            text: answer,
          });
        sent += 1;
        return;
      }
      clearInterval(timer);
      this.responding = null;
      this.session.emit({ type: 'output_audio.done', responseId, itemId, contentIndex: 0 });
      this.session.emit({
        type: 'transcript.done',
        source: 'output_audio',
        itemId,
        contentIndex: 0,
        responseId,
        transcript: answer,
      });
      this.session.emit({
        type: 'response.done',
        responseId,
        status: 'completed',
        units: [{ unit: 'audio_output_tokens', quantity: 40 }],
        usageSource: 'provider_reported',
      });
    }, FRAME_MS);
    this.responding = { responseId, itemId, timer };
  }
}

/* -------------------------------------------------------------------------- */
/*  The client                                                                 */
/* -------------------------------------------------------------------------- */

export interface FakeKaanaOptions {
  models?: KaanaModel[];
  scripted?: boolean;
}

export class FakeKaana implements KaanaClient {
  models: KaanaClient['models'];
  realtime: KaanaClient['realtime'];
  audio: KaanaClient['audio'];

  catalogue: KaanaModel[];
  /** Every session opened, newest last. */
  readonly sessions: FakeRealtimeSession[] = [];
  /** Every `connect` call, refused or not. */
  readonly connectRequests: KaanaRealtimeConnectRequest[] = [];
  /** Every transcription request. */
  readonly transcriptionRequests: Array<{
    request: KaanaTranscriptionRequest;
    options?: KaanaRequestOptions;
  }> = [];
  /** Refusals for the next `connect` calls, by model id (or `*`), consumed in order. */
  failConnect: Array<{ model: string | '*'; error: Error }> = [];
  failTranscription: Array<{ model: string | '*'; error: Error }> = [];
  failModels: Error | null = null;
  transcriptText = 'fake transcript';
  /** Whether a session emits `session.created` by itself on connect. */
  autoCreate = true;

  constructor(options: FakeKaanaOptions = {}) {
    this.catalogue = options.models ?? [fakeRealtimeModel(), fakeTranscriptionModel()];
    const scripted = options.scripted === true;

    this.models = {
      list: async () => {
        if (this.failModels) throw this.failModels;
        return this.catalogue.map((model) => structuredClone(model));
      },
    };

    this.realtime = {
      connect: async (request, options) => {
        this.connectRequests.push(request);
        const refusal = this.takeRefusal(this.failConnect, request.model);
        if (refusal) throw refusal;
        const model = this.catalogue.find((entry) => entry.modelId === request.model);
        if (!model?.capabilities.realtime) throw new FakeKaanaError('model_not_found');
        validateOpen(request, model);
        const session = new FakeRealtimeSession(request, options, scripted);
        this.sessions.push(session);
        if (this.autoCreate) {
          const limits = { ...DEFAULT_LIMITS, ...stripTextItems(request.limits) };
          const started = new Date();
          session.emit({
            type: 'session.created',
            model: `${model.modelId}@${model.currentRevision}`,
            kind: request.kind,
            config: request.config,
            limits,
            resumeWindowMs: 30_000,
            startedAt: started.toISOString(),
            expiresAt: new Date(started.getTime() + limits.maxDurationMs).toISOString(),
          });
        }
        return session;
      },
    };

    this.audio = {
      transcriptions: {
        create: async (request, options): Promise<KaanaTranscription> => {
          this.transcriptionRequests.push({ request, ...(options ? { options } : {}) });
          const refusal = this.takeRefusal(this.failTranscription, request.model);
          if (refusal) throw refusal;
          const model = this.catalogue.find((entry) => entry.modelId === request.model);
          if (!model?.capabilities.apiFormats?.includes('audio_transcriptions'))
            throw new FakeKaanaError('model_not_found');
          if (!model.audio?.audioFormats.input.includes(request.mediaType))
            throw new FakeKaanaError('invalid_request', { param: 'file' });
          const size =
            request.file instanceof Uint8Array ? request.file.byteLength : request.file.size;
          if (size > 20 * 1024 * 1024) throw new FakeKaanaError('request_too_large');
          return {
            schemaVersion: 1,
            requestId: `req_fake_${randomUUID()}`,
            model: `${model.modelId}@${model.currentRevision}`,
            text: this.transcriptText,
            ...(request.language ? { language: request.language } : {}),
            usage: [{ unit: 'audio_input_milliseconds', quantity: 1_000 }],
          };
        },
      },
    };
  }

  /** The newest session. */
  get session(): FakeRealtimeSession {
    const session = this.sessions.at(-1);
    if (!session) throw new Error('no fake realtime session was opened');
    return session;
  }

  private takeRefusal(
    list: Array<{ model: string | '*'; error: Error }>,
    model: string,
  ): Error | null {
    const index = list.findIndex((entry) => entry.model === '*' || entry.model === model);
    if (index === -1) return null;
    const [entry] = list.splice(index, 1);
    return entry!.error;
  }
}

function stripTextItems(
  limits: KaanaRealtimeConnectRequest['limits'],
): Partial<KaanaRealtimeSessionLimits> {
  if (!limits) return {};
  const { maxTextItems: _ignored, ...rest } = limits;
  return rest;
}

/** The checks `realtimeSessionOpenSchema` and the catalogue make before a grant. */
function validateOpen(request: KaanaRealtimeConnectRequest, model: KaanaModel): void {
  const { config, limits } = request;
  const invalid = (param: string) => new FakeKaanaError('invalid_request', { param });
  if (request.kind !== 'conversation') throw new FakeKaanaError('unsupported_modality');
  if (
    config.instructions !== undefined &&
    config.instructions.length > KAANA_MAX_REALTIME_INSTRUCTIONS
  )
    throw invalid('config.instructions');
  if (config.tools !== undefined) {
    if (config.tools.length > KAANA_MAX_REALTIME_TOOLS) throw invalid('config.tools');
    const names = config.tools.map((tool) => tool.name);
    if (new Set(names).size !== names.length) throw invalid('config.tools');
  }
  if (config.outputModalities === undefined) throw invalid('config.outputModalities');
  if (
    config.outputModalities.includes('audio') &&
    (config.voice === undefined || config.outputAudioFormat === undefined)
  )
    throw invalid('config');
  if (
    config.voice !== undefined &&
    !(model.audio?.voices ?? []).some((voice) => voice.id === config.voice)
  )
    throw invalid('config.voice');
  if (config.inputAudioTranscription && !model.capabilities.realtime?.inputAudioTranscription)
    throw new FakeKaanaError('unsupported_modality', { param: 'config.inputAudioTranscription' });
  if (
    limits?.idleTimeoutMs !== undefined &&
    limits.maxDurationMs !== undefined &&
    limits.idleTimeoutMs > limits.maxDurationMs
  )
    throw invalid('limits.idleTimeoutMs');
  if (limits?.maxDurationMs !== undefined && limits.maxDurationMs > 3_600_000)
    throw invalid('limits.maxDurationMs');
}

export function createFakeKaana(options: FakeKaanaOptions = {}): FakeKaana {
  return new FakeKaana(options);
}
