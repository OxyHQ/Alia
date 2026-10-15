import type { SharedValue } from 'react-native-reanimated';
import type { VoiceErrorCode } from './lib/speech-messages';
import type { VoiceCloseReason } from './lib/voice-protocol';

// ── Suggestion Types ──

/** A line the person can pick: `text` is what is shown and what is sent. */
export interface AliaSuggestion {
  id: string;
  text: string;
}

// ── Composer Types ──

/** A file in the composer's draft, on its way into a turn. */
export interface AliaAttachment {
  id: string;
  /** A `data:` URL once read; a picker's `blob:`/`file:` URI for a photo not yet read. */
  uri: string;
  type: 'image' | 'document';
  name: string;
  size: number;
  mimeType: string;
  isLoading?: boolean;
}

// ── Chat Message Types ──

export interface ResearchSource {
  id: number;
  url: string;
  title: string;
}

export interface ResearchProgress {
  phase?: string;
  message?: string;
  subQuestions?: string[];
  sourcesFound?: number;
  currentQuery?: string;
  iteration?: number;
  isComplete?: boolean;
  sources?: ResearchSource[];
  totalSearches?: number;
}

export interface PlanStep {
  action: string;
  description: string;
  toolName?: string;
}

export interface PendingPlan {
  planId: string;
  steps: PlanStep[];
  approved: boolean;
  rejected: boolean;
}

/** A message of the thread, and a tool the model called in it: the conversation runtime's records. */
export type { Message as ChatMessage, ToolInvocation } from './runtime/types';

// ── Voice Types ──

/**
 * The call's connection, coarse: what a bar or a wave needs. `reconnecting`
 * while a dropped socket resumes or Alia re-opens the session upstream.
 */
export type RoomState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
/** Who has the turn, coarse: the palette of the ambient field and the bar's word. */
export type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * The call's honest state (ADR 0017 §4). Every state is entered on an event
 * that proves it, never on a timer:
 *
 * - `connecting` — socket open → authenticated → `session.start` accepted →
 *   the realtime session created upstream (`session.ready`).
 * - `listening` — ONLY once the session is ready, the microphone delivered its
 *   first buffer and Alia acknowledged the first appended audio.
 * - `user-speaking` — the server heard speech start.
 * - `thinking` — from the end of the person's speech to the first answer
 *   audio or a tool.
 * - `using-tool` — a tool runs in Alia; `tool` is its name, for a label only.
 * - `speaking` — the first answer frame is PLAYING, not merely received.
 * - `reconnecting` — a resume, or Alia re-opening the session upstream.
 * - `ended` — the call is over; `call-moved-elsewhere` is a reason, not an error.
 * - `error` — a typed failure ended it.
 */
export type VoiceCallState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'listening' }
  | { kind: 'user-speaking' }
  | { kind: 'thinking' }
  | { kind: 'using-tool'; tool: string }
  | { kind: 'speaking' }
  | { kind: 'reconnecting' }
  | { kind: 'ended'; reason: VoiceCloseReason }
  | { kind: 'error'; code: VoiceErrorCode };

export interface VoiceToolInvocation {
  toolCallId: string;
  toolName: string;
  state: 'call' | 'result';
  args?: Record<string, unknown>;
}

export interface VoiceMessage {
  id: string;
  role: 'user' | 'assistant';
  speaker?: 'primary';
  content: string;
  timestamp: number;
  isStreaming: boolean;
  toolInvocations?: VoiceToolInvocation[];
}

// ── Voice Session (injected capability) ──

/** Everything a live call reports back to the chat shell. */
export interface VoiceSessionState {
  /** The room is up and the agent is live. */
  isConnected: boolean;
  agentState: AgentState;
  /** Audio amplitude channel that drives the ambient wave overlay. */
  waveAmplitude: SharedValue<number>;
  /** Transcript so far; the shell adapts it into the chat message list. */
  messages: VoiceMessage[];
}

export interface VoiceSessionProps {
  /** Alia API base URL. */
  apiUrl?: string;
  /**
   * The conversation the call's transcript is stored in. Omitted, each call
   * starts a conversation of its own in the person's Alia history.
   */
  conversationId?: string;
  /** The agent the call talks to; omitted, Alia. */
  agentId?: string;
  /** Language spoken (BCP-47); omitted, the platform's. */
  locale?: string;
  /** Which of the product's two voices answers. */
  voice?: 'male' | 'female';
  /** Alia stored messages of the call in the conversation: refresh the thread. */
  onMessagesSaved?: (conversationId: string, messageIds: readonly string[]) => void;
  /**
   * What the call tells the person, in the chat's language (`labels`): a failure, a call moved
   * to another device, the time limit near. Omitted, Bloom's toast.
   */
  onNotice?: (notice: VoiceNotice) => void;
  /** Called on every room, agent, or transcript change. */
  onStateChange: (state: VoiceSessionState) => void;
  /** The call is over: hung up, failed, ended by the server or dropped. The person was told why. */
  onEnd: () => void;
}

/** Something the call tells the person: a failure, how it ended, or that it is about to end. */
export interface VoiceNotice {
  kind: 'error' | 'info' | 'warning';
  text: string;
}
