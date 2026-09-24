export interface ChatHookContext {
  userId?: string;
  conversationId?: string;
  messages: any[];
  model?: string;
  /** The skills whose instructions reached the model this turn, by name. */
  skillNames?: string[];
  platform: 'app' | 'telegram';
  metadata: Record<string, any>;
}

export interface ChatHookResult {
  messages?: any[];       // Modified messages (optional)
  metadata?: Record<string, any>;  // Additional metadata to pass along
}

export interface AfterChatContext extends ChatHookContext {
  response: string;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** The `publisher/model` (or local runtime model) the turn ran on. */
  modelUsed: string;
  /**
   * What the caller asked for, before resolution — separate from `modelUsed`,
   * the `publisher/model` the turn ran on. They differ when the caller named
   * nothing and the person's default was used.
   */
  requestedModel: string;
  /** How much reasoning the caller asked for (`low`|`medium`|`high`), or null. */
  reasoningEffort: string | null;
  latencyMs: number;
  /**
   * Milliseconds to the first streamed chunk, or null when the turn produced
   * none. Null rather than zero: zero is a fast turn.
   */
  timeToFirstTokenMs: number | null;
  /** The `AliaErrorCode` the turn ended with, or null when it succeeded. */
  errorClass: string | null;
  /** Whether the caller withdrew before the turn finished. */
  cancelled: boolean;
  /**
   * The revision-pinned model reference Kaana served this turn, or null when
   * no answer named one. Safe to record (ADR 0003); never a provider name.
   */
  resolvedModelReference: string | null;
}

export type BeforeChatHook = (ctx: ChatHookContext) => Promise<ChatHookResult | void>;
export type AfterChatHook = (ctx: AfterChatContext) => Promise<void>;

export interface ChatHook {
  name: string;
  priority?: number;  // Lower number = runs first (default: 100)
  beforeChat?: BeforeChatHook;
  afterChat?: AfterChatHook;
}
