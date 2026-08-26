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
  /** The Alia alias that served the turn. */
  modelUsed: string;
  /**
   * What the caller asked for, before resolution.
   *
   * Separate from `model`/`modelUsed` because they are the alias the provider
   * loop settled on, and the two diverge on exactly the turns worth looking
   * at — see `db/schema/usage.ts`.
   */
  requestedModel: string;
  /**
   * How much reasoning the caller asked for, or null for the default.
   *
   * Computed where `thinkingMode` is in scope, because a caller can express the
   * same intent through the flag or through `alia-v1-thinking` and the hook sees
   * only the identifier.
   */
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
}

export type BeforeChatHook = (ctx: ChatHookContext) => Promise<ChatHookResult | void>;
export type AfterChatHook = (ctx: AfterChatContext) => Promise<void>;

export interface ChatHook {
  name: string;
  priority?: number;  // Lower number = runs first (default: 100)
  beforeChat?: BeforeChatHook;
  afterChat?: AfterChatHook;
}
