// ── Welcome / Suggestion Types ──

export interface WelcomeSuggestion {
  id: string;
  title: string;
  description: string;
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

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string | Array<{ type: string; [key: string]: any }>;
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
  /** Delegated agent identity */
  agentInfo?: { id: string; name: string; avatar: string | null };
}

export interface ToolInvocation {
  toolName: string;
  state: 'call' | 'partial-call' | 'result';
  args?: Record<string, any>;
  result?: any;
  /** OpenAI-format tool call ID for matching calls to results */
  toolCallId?: string;
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
