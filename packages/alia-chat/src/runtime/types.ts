import type { PendingPlan, ResearchProgress } from '../types';

/**
 * The canonical tool invocation: streaming, the conversation hooks and the
 * thread UI all read this one shape.
 */
export interface ToolInvocation {
  toolCallId: string;
  toolName: string;
  state: 'partial-call' | 'call' | 'result';
  args?: Record<string, unknown>;
  // Tool output is dynamically shaped per tool and consumed structurally
  // (e.g. `result.results`, `result.url`) by the thread UI; typing it more
  // narrowly would require validating every tool's output shape.
  // biome-ignore lint/suspicious/noExplicitAny: structural per-tool output, see above
  result?: any;
}

/** What a message carries to the model: plain text, or multi-part once images are attached. */
export type MessageContent = string | Array<{ type: string; [key: string]: unknown }>;

/** Human-in-the-loop approval requested mid-stream for a sensitive tool call. */
export interface PendingApproval {
  requestId: string;
  toolName: string;
  description: string;
  severity: string;
  timeout: number;
  args?: Record<string, unknown>;
}

/** Resolution of a {@link PendingApproval}. */
export interface PendingApprovalResult {
  requestId: string;
  decision: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: MessageContent;
  /** Extended thinking content (when thinking mode is enabled). */
  thinking?: string;
  toolInvocations?: ToolInvocation[];
  /** Voice fields (optional, only present for voice-originated messages). */
  source?: 'text' | 'voice';
  /** Speaker identity in voice mode. */
  speaker?: 'primary';
  /**
   * The turn is being streamed into this message right now.
   *
   * Set by `useConversationStream` on the assistant placeholder it appends and
   * cleared by it when the stream ends, whichever way it ends; voice sets it
   * on its own rows. Absent on a message read back from the server.
   */
  isStreaming?: boolean;
  /**
   * How the turn that wrote this message ended, once it has: on its own
   * (`completed`), on an error (`failed`), or because the person stopped it
   * (`cancelled`). Stamped by `useConversationStream` alongside clearing
   * `isStreaming`, and absent on a message the server sent.
   */
  turnOutcome?: 'completed' | 'failed' | 'cancelled';
  /**
   * The server does not hold this message yet, so nothing can be addressed to
   * it by id — a vote, a read-aloud clip stored on it.
   *
   * Set on every message of a turn the stream sends (the question, the reply,
   * a delegated agent's answer) and cleared when that turn completes, which is
   * when the server has stored it under these same ids. A turn that failed or
   * was stopped keeps it.
   */
  unsaved?: true;
  /**
   * Agent delegation metadata, when agent mode delegates to a specialist agent.
   *
   * `character` is the agent's look as the server stores it (JSON), parsed
   * where it is drawn; absent, the default look.
   */
  agentInfo?: {
    id: string;
    name: string;
    character?: unknown;
    handle?: string;
  };
  /**
   * When the message was written, ISO — what the date separators are derived
   * from, in the reader's own timezone. Absent means the turn has not been
   * persisted yet and carries no stamp of its own.
   */
  createdAt?: string;
  // Streaming UI metadata (deep research, plan preview, tool approval)
  researchProgress?: ResearchProgress;
  pendingPlan?: PendingPlan;
  pendingApproval?: PendingApproval;
  pendingApprovalResult?: PendingApprovalResult;
}

export interface Conversation {
  id: string;
  title: string;
  lastMessage?: string;
  source?: string;
  /**
   * The agent this conversation is a stretch of, or none.
   *
   * NULLABLE, not optional-absent: the column is `agent_id text` and the list
   * route sends `c.agentId` straight through, so an ordinary conversation
   * arrives carrying an explicit `null`.
   */
  agentId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  messages: Message[];
}

/** One page of the paginated conversation list. */
export interface ConversationsPage {
  conversations: Conversation[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** React Query infinite-query cache shape for the conversation list. */
export interface ConversationsInfiniteData {
  pages: ConversationsPage[];
  pageParams: unknown[];
}

/** What a chat turn is sent with. */
export interface SendOptions {
  /** `null` explicitly withholds MCP tools; omission preserves legacy callers. */
  mcpServerId?: string | null;
  /**
   * The skills chosen for THIS message, by name. Per turn rather than per
   * session; omitted means the person chose none.
   */
  skillNames?: string[];
}

/** A resource an automation acts on or listens to. */
export interface AutomationResource {
  appId: string;
  effectiveAccountId: string;
  resourceType: string;
  resourceId: string;
}

/** What starts a scheduled task. */
export type AutomationTrigger =
  | { type: 'manual' }
  | {
      type: 'event';
      appId: string | null;
      eventType: string | null;
      resource?: AutomationResource | null;
    }
  | { type: 'schedule'; cron: string | null; timezone: string | null };
