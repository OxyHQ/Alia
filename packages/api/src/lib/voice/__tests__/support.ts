/**
 * A voice call wired to `@kaana.ai/sdk/testing` — the real `Kaana` client
 * against Kaana's own rules in memory — and in-memory stores, for the voice
 * suites. Everything the call reaches is here and observable: the upstream
 * session (`session()`, the server's, which the test drives with `emit`), the
 * commands it applied (`commands(type)`), the events and audio the client
 * received (`sink`), what was stored (`persisted`), and the credit and
 * registry calls.
 */

import { tool, type ToolSet } from 'ai';
import { vi } from 'vitest';
import { z } from 'zod';
import type { Model, RealtimeClientCommand } from '@kaana.ai/contracts';
import { createFakeKaana, type FakeKaanaServer, voiceCatalogue } from '@kaana.ai/sdk/testing';
import type { AppendedMessage } from '../../conversation-saver.js';
import type { CreditReservation } from '../../credits-manager.js';
import type { KaanaClient } from '../../kaana/port.js';
import {
  type VoiceCallEnvironment,
  type VoiceCallLimits,
  type VoiceClientSink,
  VOICE_CALL_LIMITS,
  VoiceCall,
} from '../call.js';
import type { HeldCall } from '../call-registry.js';
import { decodeAssistantAudioFrame, type SequencedVoiceEvent } from '../protocol.js';
import type { HistoryMessage, VoiceTurnInput } from '../turn.js';

export class RecordingSink implements VoiceClientSink {
  readonly events: SequencedVoiceEvent[] = [];
  readonly audio: Uint8Array[] = [];
  closed = false;
  sendEvent(event: SequencedVoiceEvent): void {
    this.events.push(event);
  }
  sendAudio(frame: Uint8Array): void {
    this.audio.push(frame);
  }
  close(): void {
    this.closed = true;
  }
  types(): string[] {
    return this.events.map((event) => event.type);
  }
  find<T extends SequencedVoiceEvent['type']>(
    type: T,
  ): Array<Extract<SequencedVoiceEvent, { type: T }>> {
    return this.events.filter((event) => event.type === type) as Array<
      Extract<SequencedVoiceEvent, { type: T }>
    >;
  }
  audioFor(itemId: string): number {
    return this.audio
      .map((frame) => decodeAssistantAudioFrame(frame))
      .filter((frame) => frame?.itemId === itemId)
      .reduce((sum, frame) => sum + (frame?.pcm.byteLength ?? 0), 0);
  }
}

export interface HarnessOptions {
  /** The catalogue Kaana serves; Kaana's own voice catalogue by default. */
  models?: readonly Model[];
  /** No Kaana client at all, as a process with no Oxy service identity. */
  noKaana?: boolean;
  /**
   * The client the call is given, around the fake's: how a test has Kaana
   * answer what its rules alone never produce (a billing refusal), with the
   * SDK's own error classes.
   */
  wrapKaana?: (kaana: KaanaClient) => KaanaClient;
  voiceMode?: boolean;
  entitlementsUnavailable?: boolean;
  turnAgent?: Awaited<ReturnType<VoiceCallEnvironment['prefetch']>>['turnAgent'];
  reserve?: (userId: string, credits: number) => Promise<CreditReservation | null>;
  history?: HistoryMessage[];
  tools?: ToolSet;
  limits?: Partial<VoiceCallLimits>;
  /** The call's clock. */
  now?: () => number;
}

export function weatherTools(execute?: (input: { city: string }) => Promise<unknown>): ToolSet {
  return {
    lookupWeather: tool({
      description: 'The weather in a city',
      inputSchema: z.object({ city: z.string() }),
      execute: execute ?? (async ({ city }: { city: string }) => ({ city, celsius: 21 })),
    }),
  };
}

export function harness(options: HarnessOptions = {}) {
  const fake = createFakeKaana({ models: options.models ?? voiceCatalogue });
  const server: FakeKaanaServer = fake.server;
  const kaana = options.noKaana ? null : (options.wrapKaana?.(fake.kaana) ?? fake.kaana);
  /** The upstream session the call opened last. */
  const session = () => {
    const last = server.sessions.at(-1);
    if (!last) throw new Error('No upstream session was opened');
    return last;
  };
  /** The commands of one type the last session applied. */
  const commands = <T extends RealtimeClientCommand['type']>(type: T) =>
    session().commands.filter((command) => command.type === type) as Array<
      Extract<RealtimeClientCommand, { type: T }>
    >;
  const persisted: AppendedMessage[][] = [];
  const reservations: CreditReservation[] = [];
  const reserve = vi.fn(
    options.reserve ??
      (async (userId: string, credits: number): Promise<CreditReservation> => {
        const reservation: CreditReservation = {
          userId,
          creditsReserved: credits,
          initialFreeCredits: 0,
          initialPaidCredits: 1_000,
          grantKind: 'paid_balance',
        };
        reservations.push(reservation);
        return reservation;
      }),
  );
  const finalize = vi.fn(async (_reservation: CreditReservation, _credits: number) => undefined);
  const refund = vi.fn(async (_reservation: CreditReservation) => undefined);
  let held: HeldCall | null = null;
  const startCall = vi.fn(async (input: { call: HeldCall }) => {
    held = input.call;
    return { replaced: 0 };
  });
  const finishCall = vi.fn(async () => undefined);
  let history = options.history ?? [];
  const turnInputs: VoiceTurnInput[] = [];
  const tools = options.tools ?? weatherTools();
  const instructionsFor = vi.fn(
    async (h: readonly HistoryMessage[]) => `INSTRUCTIONS(${h.length})`,
  );
  const announce = vi.fn();
  const titleConversation = vi.fn();
  const recordAnalytics = vi.fn(async () => undefined);

  const env: VoiceCallEnvironment = {
    kaana,
    prefetch: async () => ({
      userMemory: null,
      oxyUser: null,
      entitlements: options.entitlementsUnavailable
        ? null
        : {
            features: { 'voice-mode': options.voiceMode ?? true },
            planId: options.voiceMode === false ? 'free' : 'go',
            entitlement: {} as never,
          },
      turnAgent: options.turnAgent ?? { kind: 'none' },
    }),
    credits: { reserve, finalize, refund },
    startCall: startCall as unknown as VoiceCallEnvironment['startCall'],
    finishCall,
    loadHistory: async () => history,
    buildTurn: async (input) => {
      turnInputs.push(input);
      return {
        tools,
        activeToolNames: () => Object.keys(tools),
        instructions: instructionsFor,
      };
    },
    persist: async (params) => {
      persisted.push([...params.messages]);
      history = [
        ...history,
        ...params.messages.map((message) => ({ role: message.role, content: message.content })),
      ];
    },
    announce,
    titleConversation,
    recordAnalytics,
  };
  const sink = new RecordingSink();
  const call = new VoiceCall(
    env,
    'user-1',
    'token-1',
    { ...VOICE_CALL_LIMITS, ...options.limits },
    options.now,
  );
  call.attach(sink);
  return {
    call,
    sink,
    server,
    session,
    commands,
    env,
    persisted,
    reservations,
    reserve,
    finalize,
    refund,
    startCall,
    finishCall,
    turnInputs,
    instructionsFor,
    announce,
    titleConversation,
    recordAnalytics,
    held: () => held,
  };
}

/** A model of Kaana's own voice catalogue, by id. */
export function catalogueModel(modelId: string): Model {
  const model = voiceCatalogue.find((entry) => entry.modelId === modelId);
  if (!model) throw new Error(`No ${modelId} in Kaana's voice catalogue`);
  return model;
}

/** Kaana's realtime voice model, the one a call opens on by default. */
export const REALTIME = voiceCatalogue.find((model) => model.capabilities.realtime)!;

/** Another realtime model like {@link REALTIME}, under its own id and price per minute. */
export function realtimeModel(modelId: string, usdPerMinute: string): Model {
  return {
    ...REALTIME,
    modelId,
    pricePerMinute: { amount: usdPerMinute, currency: 'USD' },
  } as Model;
}

export const START = {
  conversationId: 'conv-1',
  voice: 'female' as const,
  locale: 'es-ES',
};

/** Poll until `ready`, or throw naming what never happened. */
export async function until(label: string, ready: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** PCM16 of `ms` milliseconds at 24 kHz, as base64 for an `output_audio.delta`. */
export function pcmBase64(ms: number): string {
  return Buffer.alloc(ms * 48).toString('base64');
}
