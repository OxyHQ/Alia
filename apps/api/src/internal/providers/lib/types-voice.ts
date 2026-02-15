/**
 * Voice Provider Types
 *
 * Type definitions for real-time voice calling functionality
 * Compatible with OpenAI Realtime API specification
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
  clientSocket: WebSocket;          // Client-facing WebSocket
  providerSocket: WebSocket | null; // Provider WebSocket connection
  state: VoiceSessionState;
  startTime: Date;
  userId: string;
  aliaModelId: string;
  provider: string;
  providerModelId: string;
  creditReservation: CreditReservation | null;

  // Audio state
  lastActivityTime: Date;

  // Billing
  billingTimer: NodeJS.Timeout | null;
  minutesElapsed: number;
  costPerMinute: number;             // Provider's cost per minute

  // Session metadata
  audioFormat: string;
  sampleRate: number;
  config: VoiceSessionConfig;

  // Server-side tool executors for function calling
  toolExecutors?: Map<string, (args: any) => Promise<any>>;
}

// ============== VOICE SESSION CONFIG ==============

export interface VoiceSessionConfig {
  model: string;
  audioFormat?: string;              // 'pcm16', 'opus', 'g711_ulaw', 'g711_alaw'
  sampleRate?: number;               // 16000, 24000, 48000
  instructions?: string;             // System instructions
  voice?: string;                    // Voice ID (e.g., 'alloy', 'echo', 'nova')
  temperature?: number;              // Temperature for responses
  tools?: OpenAITool[];             // Function calling tools
  maxDuration?: number;              // Max duration in minutes
}

// ============== VOICE PROVIDER ==============

export interface VoiceProvider {
  name: string;
  isEnabled: () => boolean;
  voice: {
    // Capabilities
    capabilities: VoiceCapabilities;

    // Create WebSocket connection to provider
    connect: (
      key: KeyConfig,
      config: VoiceSessionConfig
    ) => Promise<WebSocket>;

    // Translate events between OpenAI format and provider format
    // Optional: if provider uses OpenAI format, these can be omitted
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
