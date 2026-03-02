export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolInvocations?: ToolInvocation[];
  createdAt: number;
}

export interface ToolInvocation {
  toolName: string;
  state: 'call' | 'result';
  args?: Record<string, any>;
  result?: any;
}

export interface AliaChatSuggestion {
  label: string;
  icon?: string;
  prompt: string;
}
