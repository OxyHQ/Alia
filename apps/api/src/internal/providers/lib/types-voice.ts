/**
 * Voice Provider Types
 *
 * Type definitions for real-time voice calling functionality
 * Compatible with OpenAI Realtime API specification + LiveKit rooms
 */

import type WebSocket from 'ws';
import type { KeyConfig, OpenAITool } from './types.js';
import type { CreditReservation } from '../../../lib/credits-manager.js';

// ============== VOICE CAPABILITIES ==============

export interface VoiceCapabilities {
  audioFormats: string[];           // ['pcm16', 'opus', 'g711']
  sampleRates: number[];            // [16000, 24000, 48000]
  languages: string[];              // Supported languages
  maxDurationMinutes: number;       // Provider-specific limits
  supportsInterruption: boolean;    // Turn detection support
  supportsFunctionCalling: boolean; // Tool use during voice calls
  latencyMs: number;                // Average latency
}

// ============== VOICE SESSION ==============

export type VoiceSessionState = 'connecting' | 'active' | 'disconnecting' | 'closed';

export interface VoiceSession {
  sessionId: string;
  providerSocket: WebSocket | null; // Provider WebSocket connection (OpenAI/Grok)
  state: VoiceSessionState;
  startTime: Date;
  userId: string;
  clarityModelId: string;
  provider: string;
  providerModelId: string;
  creditReservation: CreditReservation | null;

  // LiveKit room
  roomName: string;
  agentBridge: LiveKitAgentBridgeRef | null;

  // Audio state
  lastActivityTime: Date;
  lastUserSpeechTime: Date | null;

  // Billing
  billingTimer: NodeJS.Timeout | null;
  minutesElapsed: number;
  costPerMinute: number;

  // Session metadata
  audioFormat: string;
  sampleRate: number;
  config: VoiceSessionConfig;

  // Server-side tool executors for function calling
  toolExecutors?: Map<string, (args: any) => Promise<any>>;

  // Inactivity timer (10s after AI finishes speaking in normal mode)
  userSilenceTimer: NodeJS.Timeout | null;

  // Cohost
  cohostEnabled: boolean;
  cohostBridge: LiveKitAgentBridgeRef | null;
  cohostProviderSocket: WebSocket | null;
  cohostProvider: string | null;
  cohostProviderModelId: string | null;
  cohostCreditReservation: CreditReservation | null;
  cohostCostPerMinute: number;
  cohostBillingTimer: NodeJS.Timeout | null;
  cohostMinutesElapsed: number;
  cohostState: CohostState | null;
  cohostToolExecutors?: Map<string, (args: any) => Promise<any>>;
  cohostInactivityTimer: NodeJS.Timeout | null;
  recentTranscripts: TranscriptEntry[];

  /** Stored VAD config from initial session setup, used for toggling VAD on/off during cohost turns */
  originalVadConfig: object | null;

  // Tool call loop prevention — consecutive tool-only response rounds
  toolRoundsCount: number;
  cohostToolRoundsCount: number;
}

/** Opaque reference to LiveKitAgentBridge to avoid circular deps */
export interface LiveKitAgentBridgeRef {
  disconnect(): Promise<void>;
  publishData(data: object): Promise<void>;
  resetPlaybackTracking(): void;
  waitForPlaybackDrain(): Promise<void>;
  setGain(level: number): void;
}

// ============== COHOST ==============

export interface CohostConfig {
  voice: string;
  autoConverse: boolean;
  maxTurnsPerRound: number;
  turnPauseMs: number;
}

export const DEFAULT_COHOST_CONFIG: CohostConfig = {
  voice: 'nova',
  autoConverse: true,
  maxTurnsPerRound: 10,
  turnPauseMs: 1000,
};

export type CohostTurnState =
  | 'idle'
  | 'primary_speaking'
  | 'cohost_speaking'
  | 'waiting_for_next'
  | 'user_speaking';

export interface CohostState {
  turnState: CohostTurnState;
  turnsInCurrentRound: number;
  lastTranscript: string | null;
  config: CohostConfig;
  turnChangeTimeout: NodeJS.Timeout | null;
}

export interface TranscriptEntry {
  speaker: 'primary' | 'cohost' | 'user';
  text: string;
  timestamp: number;
}

// ============== VOICE SESSION CONFIG ==============

export interface VoiceSessionConfig {
  model: string;
  audioFormat?: string;
  sampleRate?: number;
  instructions?: string;
  voice?: string;
  temperature?: number;
  tools?: OpenAITool[];
  maxDuration?: number;
}

// ============== VOICE PROVIDER ==============

export interface VoiceProvider {
  name: string;
  isEnabled: () => boolean;
  voice: {
    capabilities: VoiceCapabilities;
    connect: (
      key: KeyConfig,
      config: VoiceSessionConfig
    ) => Promise<WebSocket>;
    translateClientEvent?: (event: any) => any;
    translateProviderEvent?: (event: any) => any;
  };
}

// ============== SESSION MANAGER EVENTS ==============

export interface SessionCloseReason {
  code: number;
  reason: string;
  wasClean: boolean;
}

// ============== DATA CHANNEL PROTOCOL ==============

export type AgentDataMessage =
  | { type: 'agent.state'; state: 'listening' | 'thinking' | 'speaking'; speaker: 'primary' | 'cohost' }
  | { type: 'transcript.delta'; delta: string; speaker: 'primary' | 'cohost' }
  | { type: 'transcript.done'; transcript: string; speaker: 'primary' | 'cohost' }
  | { type: 'transcript.user'; transcript: string }
  | { type: 'cohost.enabled' }
  | { type: 'cohost.disabled' }
  | { type: 'cohost.turn_changed'; speaker: 'primary' | 'cohost' | 'user' }
  | { type: 'cohost.round_complete'; turns: number }
  | { type: 'tool.call'; toolName: string; callId: string; args?: any; speaker: 'primary' | 'cohost' }
  | { type: 'tool.result'; callId: string; speaker: 'primary' | 'cohost' }
  | { type: 'session.ended'; reason: string }
  | { type: 'error'; code: string; message: string };

export type ClientDataMessage =
  | { type: 'cohost.enable' }
  | { type: 'cohost.disable' }
  | { type: 'cohost.continue' };
