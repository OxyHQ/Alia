// ── Chat Message Types ──

export interface ResearchProgress {
  phase?: string;
  message?: string;
  subQuestions?: string[];
  sourcesFound?: number;
  currentQuery?: string;
  iteration?: number;
}

export interface PendingPlan {
  planId: string;
  intent: string;
  confidence?: number;
  steps: string[];
  approved: boolean;
  rejected: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolInvocations?: ToolInvocation[];
  createdAt: number;
  /** Extended thinking / reasoning content */
  thinking?: string;
  /** Deep research progress metadata */
  researchProgress?: ResearchProgress;
  /** Plan preview data (pending approval) */
  pendingPlan?: PendingPlan;
  /** Message origin: text chat or voice */
  source?: 'text' | 'voice';
  /** Speaker identity in cohost voice mode */
  speaker?: 'primary' | 'cohost';
  /** Whether a voice transcript is still streaming */
  isStreaming?: boolean;
  /** Cached TTS audio URL for read-aloud */
  audioUrl?: string;
}

export interface ToolInvocation {
  toolName: string;
  state: 'call' | 'partial-call' | 'result';
  args?: Record<string, any>;
  result?: any;
  /** OpenAI-format tool call ID for matching calls to results */
  toolCallId?: string;
}

export interface AliaChatSuggestion {
  label: string;
  icon?: string;
  prompt: string;
}

// ── Voice Types ──

export type RoomState = 'disconnected' | 'connecting' | 'connected' | 'error';
export type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface VoiceToolInvocation {
  toolCallId: string;
  toolName: string;
  state: 'call' | 'result';
  args?: any;
}

export interface VoiceMessage {
  id: string;
  role: 'user' | 'assistant';
  speaker?: 'primary' | 'cohost';
  content: string;
  timestamp: number;
  isStreaming: boolean;
  toolInvocations?: VoiceToolInvocation[];
}
