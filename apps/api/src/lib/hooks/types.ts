export interface ChatHookContext {
  userId?: string;
  conversationId?: string;
  messages: any[];
  model?: string;
  skillId?: string;
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
  modelUsed: string;
  latencyMs: number;
}

export type BeforeChatHook = (ctx: ChatHookContext) => Promise<ChatHookResult | void>;
export type AfterChatHook = (ctx: AfterChatContext) => Promise<void>;

export interface ChatHook {
  name: string;
  priority?: number;  // Lower number = runs first (default: 100)
  beforeChat?: BeforeChatHook;
  afterChat?: AfterChatHook;
}
