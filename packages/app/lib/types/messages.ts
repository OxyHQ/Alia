/**
 * Canonical ToolInvocation type.
 * Used across streaming, conversation hooks, and chat UI.
 */
export interface ToolInvocation {
  toolCallId: string;
  toolName: string;
  state: 'partial-call' | 'call' | 'result';
  args?: any;
  result?: any;
}
