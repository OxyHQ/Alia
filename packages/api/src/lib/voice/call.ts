/**
 * One voice call: Alia between the person's socket and a Kaana realtime
 * session (ADR 0017 §3).
 *
 *   socket ──audio──▶ VoiceCall ──appendAudio──▶ Kaana session ──▶ provider
 *          ◀─audio + events── │ ◀──server events──┘
 *                             ├─ tools run HERE (`tool-bridge.ts`)
 *                             ├─ transcripts → messages (`appendConversationMessages`)
 *                             ├─ credits per minute (`credits.ts`)
 *                             └─ one call per person (`call-registry.ts`)
 *
 * The device gets audio, transcripts and a few UI events; never an
 * instruction, a tool schema, tool arguments or a result.
 *
 * ## Opening, in the ADR's order
 *
 * Plan (`voice-mode`, enforced HERE, not only by the app) → the agent → the
 * realtime model, computed from Kaana's catalogue → the first credit block →
 * the one-call rule (this call takes over any other) → the turn's inputs and
 * tools → Kaana. The client stays `connecting` until Kaana's
 * `session.created` (→ `session.ready`).
 *
 * ## Turns and barge-in are the provider's
 *
 * `server_vad` with `createResponse` and `interruptResponse`. On
 * `input_audio.speech_started` Alia forwards `user.speech_started`; the client
 * flushes its playback and reports how much of the item it played
 * (`playback.interrupted`), and Alia truncates the item there, so the model
 * remembers what was heard.
 *
 * ## Transcripts become messages
 *
 * Each exchange is appended as it completes — the person's words (the
 * session's own input transcription) and the answer (its output transcript,
 * with the tool round trips) — so the thread survives a dropped call. An
 * interrupted answer is stored whole with the milliseconds that were heard. A
 * response with no output stores nothing.
 */

import { randomUUID } from 'node:crypto';
import type { VoiceCallEndReason } from '../../db/schema/voice.js';
import type { ToolInvocation } from '../../domain/conversation.js';
import type { HydratedAgent } from '../agent-identity.js';
import type { PrefetchedTurnInputs, TurnIdentity } from '../chat/turn-inputs.js';
import type { AppendedMessage } from '../conversation-saver.js';
import type {
  KaanaClient,
  KaanaRealtimeClientEvent,
  KaanaRealtimeServerEvent,
  KaanaRealtimeSession,
  KaanaUsage,
} from '../kaana/port.js';
import { log } from '../logger.js';
import {
  billsSessionTime,
  rankRealtimeCandidates,
  type RealtimeCandidate,
  usdOfUnits,
  usdPerUnit,
} from '../models/voice-models.js';
import type { startCall } from './call-registry.js';
import { type VoiceCreditDeps, VoiceCreditMeter } from './credits.js';
import { isModelRefusal, VoiceFailure, voiceFailureFromKaana, VOICE_ERROR_TEXT } from './errors.js';
import {
  encodeAssistantAudioFrame,
  MAX_CLIENT_AUDIO_FRAME_BYTES,
  type ProductVoice,
  type SequencedVoiceEvent,
  VOICE_BYTES_PER_MS,
  type VoiceCloseReason,
  type VoiceSessionEvent,
} from './protocol.js';
import { runTool, toRealtimeTools } from './tool-bridge.js';
import type { HistoryMessage, VoiceTurnContext, VoiceTurnInput } from './turn.js';

/* -------------------------------------------------------------------------- */
/*  Product rules                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Alia's product rules for every call (ADR 0017 §3, "Limits"). Not capacity
 * limits: concurrency and spend are the Alia app's policy in Oxy Console.
 */
export interface VoiceCallLimits {
  readonly maxDurationMs: number;
  readonly idleTimeoutMs: number;
  /** The client is told this long before the duration ends. */
  readonly warningBeforeMs: number;
  /** A dropped socket may resume within this. */
  readonly resumeWindowMs: number;
  /** How long an interrupted answer waits for the client's played milliseconds. */
  readonly interruptWaitMs: number;
  /** How long a person's turn waits for its transcript before it is dropped. */
  readonly userTranscriptWaitMs: number;
  readonly creditCheckMs: number;
  /** New upstream sessions one call may open after the first. */
  readonly maxReopens: number;
  /** Events kept for a resume. */
  readonly replayEvents: number;
}

export const VOICE_CALL_LIMITS: VoiceCallLimits = {
  maxDurationMs: 30 * 60_000,
  idleTimeoutMs: 2 * 60_000,
  warningBeforeMs: 60_000,
  resumeWindowMs: 30_000,
  interruptWaitMs: 1_500,
  userTranscriptWaitMs: 8_000,
  creditCheckMs: 15_000,
  maxReopens: 2,
  replayEvents: 500,
};

/** The upstream session's ceilings, signed per session (ADR 0017 §3 table). */
function sessionLimits(maxDurationMs: number, idleTimeoutMs: number) {
  const audioBytes = Math.ceil((maxDurationMs * VOICE_BYTES_PER_MS) / 1000) * 1000;
  return {
    maxDurationMs,
    idleTimeoutMs: Math.min(idleTimeoutMs, maxDurationMs),
    maxInputAudioBytes: audioBytes,
    maxOutputAudioBytes: audioBytes,
    maxResponses: 500,
    // History travels in the instructions, never as billable text items.
    maxTextItems: 0,
  };
}

const END_REASON: Readonly<Record<VoiceCloseReason, VoiceCallEndReason>> = {
  hangup: 'hangup',
  'call-moved-elsewhere': 'moved_elsewhere',
  'max-duration': 'max_duration',
  'idle-timeout': 'idle_timeout',
  'credits-exhausted': 'credits_exhausted',
  error: 'error',
  'server-shutdown': 'server_shutdown',
};

/* -------------------------------------------------------------------------- */
/*  What the call needs from the world                                         */
/* -------------------------------------------------------------------------- */

/** The client end of a call: the socket, or nothing while it is away. */
export interface VoiceClientSink {
  sendEvent(event: SequencedVoiceEvent): void;
  sendAudio(frame: Uint8Array): void;
  close(): void;
}

export interface VoiceCallEnvironment {
  readonly kaana: KaanaClient | null;
  prefetch(identity: TurnIdentity): Promise<PrefetchedTurnInputs>;
  readonly credits?: VoiceCreditDeps;
  startCall: typeof startCall;
  finishCall(callId: string, reason: VoiceCallEndReason): Promise<void>;
  loadHistory(oxyUserId: string, conversationId: string): Promise<HistoryMessage[]>;
  buildTurn(input: VoiceTurnInput): Promise<VoiceTurnContext>;
  persist(params: {
    userId: string;
    conversationId: string;
    messages: readonly AppendedMessage[];
    agentId?: string;
    titleOnInsert: string;
  }): Promise<void>;
  /** Tell the person's open clients (socket.io `conversation:message`). */
  announce(oxyUserId: string, conversationId: string, messages: readonly AppendedMessage[]): void;
  titleConversation(oxyUserId: string, conversationId: string, firstUserText: string): void;
  recordAnalytics(record: {
    oxyUserId: string;
    conversationId: string;
    model: string;
    resolvedModelReference: string | null;
    latencyMs: number;
    errorClass: string | null;
  }): Promise<void>;
}

export interface VoiceCallStart {
  readonly conversationId: string;
  readonly agentId?: string;
  readonly voice: ProductVoice;
  readonly locale: string;
}

/* -------------------------------------------------------------------------- */
/*  The exchange ledger                                                        */
/* -------------------------------------------------------------------------- */

interface UserEntry {
  kind: 'user';
  itemId: string;
  text: string | null;
  deadline: number;
}

interface TurnEntry {
  kind: 'assistant';
  /** Output transcripts by audio item, in the order the items began. */
  texts: Map<string, string>;
  toolInvocations: ToolInvocation[];
  audioItems: Set<string>;
  interruptedAfterMs?: number;
  done: boolean;
  /** Set when the turn was cancelled while it spoke: wait this long for the played ms. */
  interruptDeadline?: number;
}

type LedgerEntry = UserEntry | TurnEntry;

interface ResponseState {
  readonly turn: TurnEntry;
  toolCalls: number;
  readonly pending: Promise<void>[];
  audioItem: string | null;
}

interface ToolCallState {
  name: string;
  args: string;
  responseId: string;
}

interface UpstreamState {
  readonly session: KaanaRealtimeSession;
  requestId: string | null;
  createdAt: number | null;
  responseUnits: KaanaUsage;
  closedUnits: KaanaUsage | null;
}

function addUnits(into: KaanaUsage, units: KaanaUsage): void {
  for (const { unit, quantity } of units) {
    const existing = into.find((entry) => entry.unit === unit);
    if (existing) existing.quantity += quantity;
    else into.push({ unit, quantity });
  }
}

/* -------------------------------------------------------------------------- */
/*  The call                                                                   */
/* -------------------------------------------------------------------------- */

type CallState = 'idle' | 'opening' | 'live' | 'reconnecting' | 'closing' | 'closed';

export class VoiceCall {
  /** What a client resumes with. */
  readonly id = `vs_${randomUUID()}`;
  /** The `voice_calls` row. */
  readonly callId = `vc_${randomUUID()}`;

  private state: CallState = 'idle';
  private sink: VoiceClientSink | null = null;
  private seq = 0;
  private readonly replay: SequencedVoiceEvent[] = [];
  private accessToken: string;

  private start: VoiceCallStart | null = null;
  private linkedAgent: HydratedAgent | null = null;
  private candidate: RealtimeCandidate | null = null;
  private meter: VoiceCreditMeter | null = null;
  private turn: VoiceTurnContext | null = null;
  private registered = false;
  private historyWasEmpty = false;
  private firstPersist = true;

  private upstream: UpstreamState | null = null;
  private pastUsd = 0;
  private servedModel: string | null = null;
  private servedEver = false;
  private openedAt: number | null = null;
  private reopens = 0;
  private inputAcknowledged = false;
  private commandCount = 0;
  private sentToolNames: string[] = [];

  private readonly ledger: LedgerEntry[] = [];
  private currentTurn: TurnEntry | null = null;
  private readonly responses = new Map<string, ResponseState>();
  private readonly toolCalls = new Map<string, ToolCallState>();
  private readonly audioBytes = new Map<string, number>();
  private readonly interrupted = new Map<string, number>();
  private responsesInFlight = 0;
  private endAfterResponse = false;
  private persisting: Promise<void> = Promise.resolve();
  private readonly toolAbort = new AbortController();

  private durationTimer: NodeJS.Timeout | null = null;
  private warningTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private creditTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private ledgerTimer: NodeJS.Timeout | null = null;
  private ending: Promise<void> | null = null;
  private failure: VoiceFailure | null = null;
  private closeReason: VoiceCloseReason | null = null;
  private resolveEnded: () => void = () => undefined;
  /** Resolves once the call has fully ended (stored, settled, told). */
  readonly ended = new Promise<void>((resolve) => {
    this.resolveEnded = resolve;
  });

  constructor(
    private readonly env: VoiceCallEnvironment,
    readonly oxyUserId: string,
    accessToken: string,
    private readonly limits: VoiceCallLimits = VOICE_CALL_LIMITS,
    private readonly now: () => number = Date.now,
  ) {
    this.accessToken = accessToken;
  }

  get isClosed(): boolean {
    return this.state === 'closing' || this.state === 'closed';
  }

  /** A fresher token for the same person: the tools act with it from now on. */
  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  /* ------------------------------ the client ------------------------------ */

  /**
   * The socket is (back) here. With `afterSeq`, a resume: every event after it
   * is replayed, or `false` when they are no longer kept.
   */
  attach(sink: VoiceClientSink, afterSeq?: number): boolean {
    if (this.isClosed) return false;
    if (afterSeq !== undefined) {
      const oldest = this.replay[0]?.seq ?? this.seq;
      if (afterSeq + 1 < oldest) return false;
    }
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.sink = sink;
    if (afterSeq !== undefined) {
      for (const event of this.replay) if (event.seq > afterSeq) sink.sendEvent(event);
      this.emit({ type: 'session.resumed', afterSeq });
    }
    return true;
  }

  /** The socket went away without hanging up: keep the call for the resume window. */
  detach(sink: VoiceClientSink): void {
    if (this.sink !== sink) return;
    this.sink = null;
    if (this.isClosed) return;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      void this.end('error', new VoiceFailure('resume-unavailable'));
    }, this.limits.resumeWindowMs);
    this.graceTimer.unref?.();
  }

  private emit(event: VoiceSessionEvent): void {
    const sequenced = { ...event, seq: this.seq++ } as SequencedVoiceEvent;
    this.replay.push(sequenced);
    if (this.replay.length > this.limits.replayEvents) this.replay.shift();
    this.sink?.sendEvent(sequenced);
  }

  /** Microphone audio from the client. */
  onClientAudio(frame: Uint8Array): void {
    const upstream = this.upstream;
    if (this.state !== 'live' || !upstream || upstream.createdAt === null) return;
    if (frame.byteLength === 0 || frame.byteLength > MAX_CLIENT_AUDIO_FRAME_BYTES) return;
    try {
      upstream.session.appendAudio(frame);
    } catch (error) {
      log.voice.warn({ err: error, callId: this.callId }, 'Audio not appended upstream');
      return;
    }
    if (!this.inputAcknowledged) {
      this.inputAcknowledged = true;
      this.emit({ type: 'input.ready' });
    }
  }

  /** The client flushed its playback after `user.speech_started`. */
  onPlaybackInterrupted(itemId: string, playedMs: number): void {
    const sentMs = (this.audioBytes.get(itemId) ?? 0) / VOICE_BYTES_PER_MS;
    if (sentMs === 0) return;
    const heard = Math.max(0, Math.min(Math.floor(playedMs), Math.floor(sentMs)));
    this.interrupted.set(itemId, heard);
    if (heard < Math.floor(sentMs) && this.state === 'live')
      this.command({
        type: 'conversation.item.truncate',
        itemId,
        contentIndex: 0,
        audioEndMs: heard,
      });
    for (const entry of this.ledger)
      if (entry.kind === 'assistant' && entry.audioItems.has(itemId))
        entry.interruptedAfterMs = heard;
    this.flushLedger(false);
  }

  /* -------------------------------- opening ------------------------------- */

  async open(start: VoiceCallStart): Promise<void> {
    if (this.state !== 'idle') return;
    this.state = 'opening';
    this.start = start;
    this.emit({ type: 'session.accepted', voiceSessionId: this.id, callId: this.callId });
    try {
      const inputs = await this.env.prefetch({
        oxyUserId: this.oxyUserId,
        accessToken: this.accessToken,
        isDirectUserSession: true,
        ...(start.agentId === undefined ? {} : { requestedAgentId: start.agentId }),
      });
      // `voice-mode` is enforced by the server, not only by the app.
      if (inputs.entitlements === null)
        throw new VoiceFailure('realtime-unavailable', { retryable: true });
      if (!inputs.entitlements.features['voice-mode']) throw new VoiceFailure('plan-required');

      const agent = inputs.turnAgent;
      if (agent.kind === 'agent') {
        // A product's agent is reached through its application's lane, never a call.
        if (agent.agent.applicationId != null) throw new VoiceFailure('agent-unavailable');
        this.linkedAgent = agent.agent;
      } else if (agent.kind !== 'none') {
        throw new VoiceFailure(
          agent.kind === 'resolution_unavailable' || agent.kind === 'identity_unavailable'
            ? 'realtime-unavailable'
            : 'agent-unavailable',
          { retryable: agent.kind !== 'unavailable' },
        );
      }

      const kaana = this.env.kaana;
      if (!kaana) throw new VoiceFailure('realtime-unavailable');
      const models = await kaana.models
        .list({ onBehalfOfUserId: this.oxyUserId })
        .catch((error: unknown) => {
          throw voiceFailureFromKaana(error);
        });
      // At most two candidates, and only on the model's own refusal (ADR 0017 §2).
      const candidates = rankRealtimeCandidates(models, start).slice(0, 2);
      if (candidates.length === 0) throw new VoiceFailure('realtime-unavailable');

      this.meter = new VoiceCreditMeter(this.oxyUserId, this.env.credits);
      if (!(await this.meter.open(candidates[0]!.usdPerMinute)))
        throw new VoiceFailure('credits-exhausted');
      if (this.isClosed) return;

      await this.env.startCall({
        callId: this.callId,
        oxyUserId: this.oxyUserId,
        conversationId: start.conversationId,
        agentId: this.linkedAgent?._id ?? null,
        call: { takenOver: () => this.end('call-moved-elsewhere') },
      });
      this.registered = true;
      if (this.isClosed) {
        // Hung up while the row was being written: the ending may have run
        // before it existed, so it is ended here (a second end is a no-op).
        await this.env.finishCall(this.callId, END_REASON[this.closeReason ?? 'hangup']);
        return;
      }

      const history = await this.env.loadHistory(this.oxyUserId, start.conversationId);
      this.historyWasEmpty = history.length === 0;
      this.turn = await this.env.buildTurn({
        oxyUserId: this.oxyUserId,
        accessToken: () => this.accessToken,
        conversationId: start.conversationId,
        requestId: this.callId,
        linkedAgent: this.linkedAgent,
        userMemory: inputs.userMemory,
        oxyUser: inputs.oxyUser,
        language: candidates[0]!.language,
        history,
        onApprovalRequested: (toolName) => this.emit({ type: 'approval.requested', toolName }),
      });
      if (this.isClosed) return;
      await this.connect(candidates, history);
    } catch (error) {
      await this.end('error', error instanceof VoiceFailure ? error : voiceFailureFromKaana(error));
    }
  }

  private command(
    body: DistributiveOmit<KaanaRealtimeClientEvent, 'schemaVersion' | 'requestId' | 'commandId'>,
  ): void {
    const upstream = this.upstream;
    if (!upstream || upstream.requestId === null) return;
    try {
      upstream.session.send({
        schemaVersion: 1,
        requestId: upstream.requestId,
        commandId: `${this.callId}:${++this.commandCount}`,
        ...body,
      } as KaanaRealtimeClientEvent);
    } catch (error) {
      log.voice.warn(
        { err: error, type: body.type, callId: this.callId },
        'Command not sent upstream',
      );
    }
  }

  /** Open the upstream session on the first candidate that does not refuse it. */
  private async connect(
    candidates: readonly RealtimeCandidate[],
    history: readonly HistoryMessage[],
  ): Promise<void> {
    const kaana = this.env.kaana;
    const turn = this.turn;
    const start = this.start;
    if (!kaana || !turn || !start) throw new VoiceFailure('realtime-unavailable');
    const instructions = await turn.instructions(history);
    this.sentToolNames = turn.activeToolNames();
    const tools = toRealtimeTools(turn.tools, this.sentToolNames);
    const elapsed = this.openedAt === null ? 0 : this.now() - this.openedAt;
    const remaining = Math.max(1_000, this.limits.maxDurationMs - elapsed);

    let session: KaanaRealtimeSession | null = null;
    for (const [index, candidate] of candidates.entries()) {
      try {
        session = await kaana.realtime.connect(
          {
            model: candidate.model.modelId,
            type: 'session.open',
            kind: 'conversation',
            transport: 'websocket',
            config: {
              instructions,
              outputModalities: ['audio'],
              voice: candidate.voiceId,
              inputAudioFormat: 'pcm16_24khz',
              outputAudioFormat: 'pcm16_24khz',
              // The only mode every provider accepts; barge-in is the provider's.
              turnDetection: { type: 'server_vad', createResponse: true, interruptResponse: true },
              // The person's words become messages: transcribed inside the session.
              inputAudioTranscription: { language: candidate.language },
              ...(tools.length > 0 ? { tools, toolChoice: 'auto' as const } : {}),
            },
            limits: sessionLimits(remaining, this.limits.idleTimeoutMs),
            clientSessionId: this.callId,
            labels: { surface: 'alia-voice' },
          },
          { onBehalfOfUserId: this.oxyUserId, idempotencyKey: `${this.callId}:${this.reopens}` },
        );
        this.candidate = candidate;
        break;
      } catch (error) {
        if (index < candidates.length - 1 && isModelRefusal(error)) {
          log.voice.warn(
            { model: candidate.model.modelId, callId: this.callId },
            'Realtime model refused the call; trying the next candidate',
          );
          continue;
        }
        throw voiceFailureFromKaana(error);
      }
    }
    if (!session || !this.candidate) throw new VoiceFailure('realtime-unavailable');
    this.meter?.reprice(this.candidate.usdPerMinute);
    if (this.isClosed) {
      await session.close().catch(() => undefined);
      return;
    }
    const upstream: UpstreamState = {
      session,
      requestId: null,
      createdAt: null,
      responseUnits: [],
      closedUnits: null,
    };
    this.upstream = upstream;
    this.inputAcknowledged = false;
    void this.pump(upstream);
  }

  /* -------------------------------- upstream ------------------------------ */

  private async pump(upstream: UpstreamState): Promise<void> {
    try {
      for await (const event of upstream.session) {
        if (this.upstream !== upstream) {
          if (event.type === 'session.closed') upstream.closedUnits = event.units;
          continue;
        }
        this.handle(upstream, event);
        if (event.type === 'session.closed') return;
      }
    } catch (error) {
      if (this.isClosed || this.upstream !== upstream) return;
      log.voice.warn({ err: error, callId: this.callId }, 'Upstream session lost; resuming');
      await this.recover(upstream);
    }
  }

  /** Alia ↔ Kaana dropped: resume within Kaana's window, else a new session under the same call. */
  private async recover(upstream: UpstreamState): Promise<void> {
    this.state = 'reconnecting';
    this.emit({ type: 'session.reconnecting' });
    try {
      await upstream.session.resume();
      if (this.isClosed) return;
      this.state = 'live';
      void this.pump(upstream);
      return;
    } catch {
      await this.reopen();
    }
  }

  private async reopen(): Promise<void> {
    if (this.isClosed) return;
    this.reopens += 1;
    if (this.reopens > this.limits.maxReopens || !this.candidate || !this.turn || !this.start) {
      await this.end('error', new VoiceFailure('realtime-failed', { retryable: true }));
      return;
    }
    this.state = 'reconnecting';
    this.emit({ type: 'session.reconnecting' });
    const previous = this.upstream;
    if (previous) {
      this.pastUsd += this.usdOf(previous);
      this.upstream = null;
      void previous.session.close().catch(() => undefined);
    }
    // What the old session said is in the new one's instructions.
    this.closeOpenTurn('cancelled');
    this.flushLedger(true);
    await this.persisting;
    try {
      const history = await this.env.loadHistory(this.oxyUserId, this.start.conversationId);
      await this.connect([this.candidate], history);
    } catch (error) {
      await this.end('error', error instanceof VoiceFailure ? error : voiceFailureFromKaana(error));
    }
  }

  private handle(upstream: UpstreamState, event: KaanaRealtimeServerEvent): void {
    if (event.type === 'session.closed') {
      upstream.closedUnits = event.units;
      this.onUpstreamClosed(event.reason);
      return;
    }
    if (this.isClosed) return;
    switch (event.type) {
      case 'session.created':
        this.onCreated(upstream, event);
        return;
      case 'input_audio.speech_started':
        this.activity();
        this.userEntry(event.itemId);
        this.emit({ type: 'user.speech_started', itemId: event.itemId });
        return;
      case 'input_audio.speech_stopped':
        this.activity();
        this.emit({ type: 'user.speech_stopped', itemId: event.itemId });
        return;
      case 'transcript.delta': {
        const role = event.source === 'input_audio' ? 'user' : 'assistant';
        if (role === 'assistant') {
          const turn = this.openTurn();
          turn.texts.set(event.itemId, (turn.texts.get(event.itemId) ?? '') + event.text);
        }
        this.emit({ type: 'transcript.delta', role, itemId: event.itemId, text: event.text });
        return;
      }
      case 'transcript.done': {
        if (event.source === 'input_audio') {
          this.userEntry(event.itemId).text = event.transcript;
          this.flushLedger(false);
        } else {
          this.openTurn().texts.set(event.itemId, event.transcript);
        }
        this.emit({
          type: 'transcript.done',
          role: event.source === 'input_audio' ? 'user' : 'assistant',
          itemId: event.itemId,
          text: event.transcript,
        });
        return;
      }
      case 'response.created': {
        this.activity();
        this.responsesInFlight += 1;
        this.responses.set(event.responseId, {
          turn: this.openTurn(),
          toolCalls: 0,
          pending: [],
          audioItem: null,
        });
        return;
      }
      case 'output_audio.delta': {
        const response = this.responses.get(event.responseId);
        if (response) {
          response.audioItem = event.itemId;
          response.turn.audioItems.add(event.itemId);
        }
        const pcm = Buffer.from(event.data, 'base64');
        this.audioBytes.set(
          event.itemId,
          (this.audioBytes.get(event.itemId) ?? 0) + pcm.byteLength,
        );
        try {
          this.sink?.sendAudio(encodeAssistantAudioFrame(event.itemId, pcm));
        } catch (error) {
          log.voice.warn({ err: error, callId: this.callId }, 'Assistant audio not framed');
        }
        return;
      }
      case 'output_audio.done':
        this.emit({ type: 'assistant.audio_done', itemId: event.itemId });
        return;
      case 'tool_call':
        this.onToolCall(upstream, event);
        return;
      case 'response.done':
        this.onResponseDone(upstream, event);
        return;
      case 'error':
        if (event.fatal) void this.end('error', voiceFailureFromKaana(event.error));
        else
          log.voice.warn(
            { code: event.error.code, callId: this.callId },
            'Upstream refused a command; the call goes on',
          );
        return;
      default:
        return;
    }
  }

  private onCreated(
    upstream: UpstreamState,
    event: Extract<KaanaRealtimeServerEvent, { type: 'session.created' }>,
  ): void {
    upstream.requestId = event.requestId;
    upstream.createdAt = this.now();
    this.servedModel = event.model;
    this.servedEver = true;
    const first = this.openedAt === null;
    if (first) this.openedAt = this.now();
    this.state = 'live';
    const candidate = this.candidate;
    const elapsed = this.now() - (this.openedAt ?? this.now());
    this.emit({
      type: 'session.ready',
      model: {
        id: event.model,
        displayName: candidate?.model.displayName ?? event.model,
        publisher: candidate?.model.publisher.displayName ?? '',
      },
      maxDurationMs: Math.max(0, this.limits.maxDurationMs - elapsed),
      idleTimeoutMs: this.limits.idleTimeoutMs,
      resumeWindowMs: this.limits.resumeWindowMs,
    });
    if (first) this.startTimers();
    this.activity();
  }

  private onUpstreamClosed(
    reason: Extract<KaanaRealtimeServerEvent, { type: 'session.closed' }>['reason'],
  ): void {
    if (this.isClosed) return;
    switch (reason) {
      case 'client_closed':
        return;
      case 'server_shutdown':
        // Resume is per Kaana task; a task going away needs a new session.
        void this.reopen();
        return;
      case 'max_duration':
        void this.end('max-duration');
        return;
      case 'idle_timeout':
        void this.end('idle-timeout');
        return;
      case 'no_route_available':
        void this.end('error', new VoiceFailure('realtime-unavailable', { retryable: true }));
        return;
      case 'limit_exceeded':
        void this.end('error', new VoiceFailure('realtime-limited'));
        return;
      default:
        void this.end('error', new VoiceFailure('realtime-failed', { retryable: true }));
    }
  }

  /* --------------------------------- tools -------------------------------- */

  private onToolCall(
    upstream: UpstreamState,
    event: Extract<KaanaRealtimeServerEvent, { type: 'tool_call' }>,
  ): void {
    const state = this.toolCalls.get(event.toolCallId) ?? {
      name: '',
      args: '',
      responseId: event.responseId,
    };
    if (event.name) state.name = event.name;
    if (event.argumentsDelta) state.args += event.argumentsDelta;
    this.toolCalls.set(event.toolCallId, state);
    if (!event.complete) return;
    this.toolCalls.delete(event.toolCallId);

    const response = this.responses.get(state.responseId) ?? {
      turn: this.openTurn(),
      toolCalls: 0,
      pending: [],
      audioItem: null,
    };
    this.responses.set(state.responseId, response);
    response.toolCalls += 1;
    const tools = this.turn?.tools ?? {};
    const name = state.name;
    this.activity();
    this.emit({ type: 'tool.started', callId: event.toolCallId, name });
    const running = runTool(tools, name, state.args, {
      toolCallId: event.toolCallId,
      signal: this.toolAbort.signal,
    }).then((result) => {
      let args: unknown = {};
      try {
        args = state.args.trim() === '' ? {} : JSON.parse(state.args);
      } catch {
        args = state.args;
      }
      response.turn.toolInvocations.push({
        toolCallId: event.toolCallId,
        toolName: name,
        state: 'result',
        args,
        result: result.result,
      });
      if (this.upstream === upstream && !this.isClosed)
        this.command({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', callId: event.toolCallId, output: result.output },
        });
      this.emit({ type: 'tool.finished', callId: event.toolCallId, name, ok: result.ok });
      this.activity();
    });
    response.pending.push(running);
  }

  private onResponseDone(
    upstream: UpstreamState,
    event: Extract<KaanaRealtimeServerEvent, { type: 'response.done' }>,
  ): void {
    this.activity();
    this.responsesInFlight = Math.max(0, this.responsesInFlight - 1);
    addUnits(upstream.responseUnits, event.units);
    const response = this.responses.get(event.responseId);
    this.responses.delete(event.responseId);
    this.emit({
      type: 'assistant.done',
      itemId: response?.audioItem ?? null,
      status: event.status,
    });
    // Decided now, not after the tools: the next response may already be on its way.
    const continues =
      response !== undefined && response.toolCalls > 0 && event.status === 'completed';
    if (!continues) this.closeOpenTurn(event.status);
    void (async () => {
      if (continues && response) {
        await Promise.all(response.pending);
        if (this.isClosed || this.upstream !== upstream) return;
        // An app opened by `useApps` joins the session before the model goes on.
        const active = this.turn?.activeToolNames() ?? [];
        if (this.turn && active.join('\n') !== this.sentToolNames.join('\n')) {
          this.sentToolNames = active;
          this.command({
            type: 'session.update',
            config: { tools: toRealtimeTools(this.turn.tools, active) },
          });
        }
        // Providers wait for a new response after a function output.
        this.command({ type: 'response.create' });
      }
      void this.checkCredits();
      if (this.endAfterResponse && this.responsesInFlight === 0 && !this.isClosed)
        await this.end('credits-exhausted', new VoiceFailure('credits-exhausted'));
    })();
  }

  /* -------------------------------- ledger -------------------------------- */

  private userEntry(itemId: string): UserEntry {
    const existing = this.ledger.find(
      (entry): entry is UserEntry => entry.kind === 'user' && entry.itemId === itemId,
    );
    if (existing) return existing;
    const entry: UserEntry = {
      kind: 'user',
      itemId,
      text: null,
      deadline: this.now() + this.limits.userTranscriptWaitMs,
    };
    this.ledger.push(entry);
    this.scheduleLedger();
    return entry;
  }

  /** The answer being built: chained responses (tool round trips) are one turn. */
  private openTurn(): TurnEntry {
    if (this.currentTurn && !this.currentTurn.done) return this.currentTurn;
    const turn: TurnEntry = {
      kind: 'assistant',
      texts: new Map(),
      toolInvocations: [],
      audioItems: new Set(),
      done: false,
    };
    this.currentTurn = turn;
    this.ledger.push(turn);
    return turn;
  }

  private closeOpenTurn(status: string): void {
    const turn = this.currentTurn;
    if (!turn || turn.done) return;
    turn.done = true;
    this.currentTurn = null;
    if (
      status === 'cancelled' &&
      turn.audioItems.size > 0 &&
      turn.interruptedAfterMs === undefined
    ) {
      const heard = [...turn.audioItems]
        .map((item) => this.interrupted.get(item))
        .find((ms) => ms !== undefined);
      if (heard !== undefined) turn.interruptedAfterMs = heard;
      else turn.interruptDeadline = this.now() + this.limits.interruptWaitMs;
    }
    this.flushLedger(false);
  }

  private ready(entry: LedgerEntry, force: boolean): boolean {
    if (force) return true;
    if (entry.kind === 'user') return entry.text !== null || this.now() >= entry.deadline;
    if (!entry.done) return false;
    return (
      entry.interruptDeadline === undefined ||
      entry.interruptedAfterMs !== undefined ||
      this.now() >= entry.interruptDeadline
    );
  }

  private scheduleLedger(): void {
    if (this.ledgerTimer || this.isClosed) return;
    const deadlines = this.ledger.flatMap((entry) =>
      entry.kind === 'user'
        ? entry.text === null
          ? [entry.deadline]
          : []
        : entry.done &&
            entry.interruptDeadline !== undefined &&
            entry.interruptedAfterMs === undefined
          ? [entry.interruptDeadline]
          : [],
    );
    if (deadlines.length === 0) return;
    const wait = Math.max(0, Math.min(...deadlines) - this.now());
    this.ledgerTimer = setTimeout(() => {
      this.ledgerTimer = null;
      this.flushLedger(false);
    }, wait + 5);
    this.ledgerTimer.unref?.();
  }

  /** Store every exchange that is complete, in order; `force` stores what is left. */
  private flushLedger(force: boolean): void {
    const batch: AppendedMessage[] = [];
    while (this.ledger.length > 0 && this.ready(this.ledger[0]!, force)) {
      const entry = this.ledger.shift()!;
      if (entry.kind === 'user') {
        const text = entry.text?.trim() ?? '';
        if (text !== '') batch.push({ id: `voice-${randomUUID()}`, role: 'user', content: text });
        continue;
      }
      if (entry === this.currentTurn) this.currentTurn = null;
      const text = [...entry.texts.values()].join(' ').replace(/\s+/g, ' ').trim();
      if (text === '' && entry.toolInvocations.length === 0) continue;
      batch.push({
        id: `voice-${randomUUID()}`,
        role: 'assistant',
        content: text,
        ...(entry.toolInvocations.length > 0 ? { toolInvocations: entry.toolInvocations } : {}),
        ...(entry.interruptedAfterMs === undefined
          ? {}
          : { interruptedAfterMs: entry.interruptedAfterMs }),
      });
    }
    if (batch.length > 0) this.persist(batch);
    if (this.ledgerTimer) {
      clearTimeout(this.ledgerTimer);
      this.ledgerTimer = null;
    }
    if (!force) this.scheduleLedger();
  }

  private persist(batch: AppendedMessage[]): void {
    const start = this.start;
    if (!start) return;
    const firstUser = batch.find((message) => message.role === 'user')?.content ?? '';
    const titleNow = this.firstPersist && this.historyWasEmpty && firstUser !== '';
    if (firstUser !== '') this.firstPersist = false;
    this.persisting = this.persisting
      .then(async () => {
        await this.env.persist({
          userId: this.oxyUserId,
          conversationId: start.conversationId,
          messages: batch,
          ...(this.linkedAgent ? { agentId: this.linkedAgent._id } : {}),
          titleOnInsert: firstUser.slice(0, 60) || 'Voice call',
        });
        this.emit({
          type: 'messages.saved',
          conversationId: start.conversationId,
          messageIds: batch.map((message) => message.id),
        });
        this.env.announce(this.oxyUserId, start.conversationId, batch);
        if (titleNow) this.env.titleConversation(this.oxyUserId, start.conversationId, firstUser);
      })
      .catch((error: unknown) => {
        log.voice.error({ err: error, callId: this.callId }, 'Voice messages not stored');
      });
  }

  /* --------------------------- timers and credits -------------------------- */

  private startTimers(): void {
    const { maxDurationMs, warningBeforeMs, creditCheckMs } = this.limits;
    this.durationTimer = setTimeout(() => void this.end('max-duration'), maxDurationMs);
    if (maxDurationMs > warningBeforeMs)
      this.warningTimer = setTimeout(
        () =>
          this.emit({ type: 'session.warning', code: 'ending-soon', remainingMs: warningBeforeMs }),
        maxDurationMs - warningBeforeMs,
      );
    this.creditTimer = setInterval(() => void this.checkCredits(), creditCheckMs);
    for (const timer of [this.durationTimer, this.warningTimer, this.creditTimer]) timer?.unref?.();
  }

  private activity(): void {
    if (this.isClosed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.end('idle-timeout'), this.limits.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  /** What the current upstream session has cost so far, in USD. */
  private usdOf(upstream: UpstreamState): number {
    const pricing = this.candidate?.model.pricing;
    const units: KaanaUsage = upstream.closedUnits?.length
      ? upstream.closedUnits
      : (() => {
          const running = upstream.responseUnits.map((entry) => ({ ...entry }));
          // Session time is billed silence included: estimate it until Kaana reports it.
          if (
            this.candidate &&
            billsSessionTime(this.candidate.model) &&
            upstream.createdAt !== null
          )
            addUnits(running, [
              { unit: 'session_milliseconds', quantity: this.now() - upstream.createdAt },
            ]);
          return running;
        })();
    const { usd, unpriced } = usdOfUnits(pricing, units);
    if (unpriced.length > 0)
      log.voice.warn(
        { unpriced, callId: this.callId },
        'Voice usage in units the catalogue does not price',
      );
    return usd;
  }

  private runningUsd(): number {
    return this.pastUsd + (this.upstream ? this.usdOf(this.upstream) : 0);
  }

  private async checkCredits(): Promise<void> {
    if (this.state !== 'live' || !this.meter) return;
    const covered = await this.meter.cover(this.runningUsd());
    if (covered || this.isClosed) return;
    // Never mid-word: the answer being spoken finishes first.
    if (this.responsesInFlight > 0) {
      this.endAfterResponse = true;
      return;
    }
    await this.end('credits-exhausted', new VoiceFailure('credits-exhausted'));
  }

  /* --------------------------------- ending -------------------------------- */

  /** End the call once, for one reason; every path ends here. */
  end(reason: VoiceCloseReason, failure?: VoiceFailure): Promise<void> {
    if (this.ending) return this.ending;
    this.state = 'closing';
    this.closeReason = reason;
    this.failure = failure ?? null;
    this.ending = (async () => {
      for (const timer of [this.durationTimer, this.warningTimer, this.idleTimer, this.graceTimer])
        if (timer) clearTimeout(timer);
      if (this.creditTimer) clearInterval(this.creditTimer);
      this.toolAbort.abort();

      if (failure) {
        log.voice.warn({ code: failure.code, reason, callId: this.callId }, 'Voice call failed');
        this.emit({
          type: 'error',
          code: failure.code,
          message: VOICE_ERROR_TEXT[failure.code],
          retryable: failure.retryable,
          reference: this.callId,
        });
      }

      const upstream = this.upstream;
      if (upstream) {
        try {
          // Settles exactly once upstream; bounded so a hung close never holds the call.
          const units = await Promise.race([
            upstream.session.close(),
            new Promise<KaanaUsage>((resolve) => setTimeout(() => resolve([]), 5_000).unref?.()),
          ]);
          if (units.length > 0) upstream.closedUnits = units;
        } catch (error) {
          log.voice.warn(
            { err: error, callId: this.callId },
            'Upstream session did not close cleanly',
          );
        }
      }

      this.closeOpenTurn('cancelled');
      this.flushLedger(true);
      await this.persisting;

      if (this.meter) {
        if (this.servedEver) {
          const usd = this.pastUsd + (upstream ? this.usdOf(upstream) : 0);
          await this.meter.settle(usd);
        } else {
          await this.meter.release();
        }
      }
      if (this.registered && reason !== 'call-moved-elsewhere')
        await this.env.finishCall(this.callId, END_REASON[reason]);

      this.emit({ type: 'session.closed', reason });
      this.state = 'closed';
      this.sink?.close();
      this.sink = null;

      if (this.servedEver && this.start && this.servedModel) {
        await this.env
          .recordAnalytics({
            oxyUserId: this.oxyUserId,
            conversationId: this.start.conversationId,
            model: this.servedModel.split('@')[0]!,
            resolvedModelReference: this.servedModel,
            latencyMs: this.openedAt === null ? 0 : this.now() - this.openedAt,
            errorClass: this.failure?.code ?? null,
          })
          .catch((error: unknown) =>
            log.voice.warn({ err: error }, 'Voice analytics not recorded'),
          );
      }
      log.voice.info(
        { callId: this.callId, reason, model: this.servedModel, reopens: this.reopens },
        'Voice call ended',
      );
      this.resolveEnded();
    })();
    return this.ending;
  }

  /* --------------------------------- tests -------------------------------- */

  /** For tests: the price the served model puts on one session millisecond. */
  get sessionMsPrice(): number | null {
    return usdPerUnit(this.candidate?.model.pricing, 'session_milliseconds');
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
