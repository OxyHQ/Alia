/**
 * Canonical ToolInvocation type.
 * Used across streaming, conversation hooks, and chat UI.
 */
export interface ToolInvocation {
  toolCallId: string;
  toolName: string;
  state: 'partial-call' | 'call' | 'result';
  args?: Record<string, unknown>;
  // Tool output is dynamically shaped per tool and consumed structurally
  // (e.g. `result.results`, `result.url`) by thought-utils; typing it more
  // narrowly would require validating every tool's output shape.
  result?: any;
}
