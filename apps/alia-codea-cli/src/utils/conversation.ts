import { streamChat } from './api.js';
import { executeTool } from '../tools/executor.js';
import { ApprovalMode, needsApproval } from './approval.js';

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolExecution {
  id: string;
  tool: string;
  args: Record<string, any>;
  result?: string;
  success?: boolean;
  approved?: boolean;
}

export type ConversationEvent =
  | { type: 'thinking' }
  | { type: 'content'; text: string }
  | { type: 'tool_start'; execution: ToolExecution }
  | { type: 'approval_needed'; execution: ToolExecution; resolve: (approved: boolean) => void }
  | { type: 'tool_done'; execution: ToolExecution }
  | { type: 'done'; content: string }
  | { type: 'error'; message: string };

export interface ConversationOptions {
  messages: Message[];
  systemMessage: string;
  model: string;
  approvalMode: ApprovalMode;
  onEvent: (event: ConversationEvent) => void;
  requestApproval: (execution: ToolExecution) => Promise<boolean>;
  isActive: () => boolean;
}

const MAX_CONSECUTIVE_FAILURES = 2;
const MAX_TOOL_ROUNDS = 20;

export async function processConversation(opts: ConversationOptions): Promise<void> {
  const { messages, systemMessage, model, approvalMode, onEvent, requestApproval, isActive } = opts;

  let consecutiveFailures = 0;
  let toolRounds = 0;

  while (isActive()) {
    let fullContent = '';
    let toolCalls: ToolCall[] | undefined;

    onEvent({ type: 'thinking' });

    try {
      await streamChat(messages, systemMessage, model, {
        onContent: (content) => {
          if (!isActive()) return;
          fullContent += content;
          onEvent({ type: 'content', text: content });
        },
        onToolCall: () => {},
        onDone: (_content, tcs) => {
          toolCalls = tcs;
        },
        onError: (error) => {
          onEvent({ type: 'error', message: error.message });
        },
      });
    } catch (error: any) {
      onEvent({ type: 'error', message: error.message });
      break;
    }

    if (!isActive()) break;

    if (toolCalls && toolCalls.length > 0) {
      toolRounds++;

      // Safety: break if too many tool rounds
      if (toolRounds > MAX_TOOL_ROUNDS) {
        onEvent({ type: 'error', message: 'Too many tool rounds. Stopping.' });
        break;
      }

      messages.push({
        role: 'assistant',
        content: fullContent,
        tool_calls: toolCalls,
      });

      let allFailed = true;

      for (const tc of toolCalls) {
        if (!isActive()) break;

        const args = JSON.parse(tc.function.arguments);
        const execution: ToolExecution = {
          id: tc.id,
          tool: tc.function.name,
          args,
        };

        onEvent({ type: 'tool_start', execution });

        // Check approval
        if (needsApproval(tc.function.name, approvalMode)) {
          const approved = await requestApproval(execution);
          if (!approved) {
            execution.approved = false;
            execution.success = false;
            execution.result = 'User declined this action.';
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: 'User declined this action.',
            });
            onEvent({ type: 'tool_done', execution });
            continue;
          }
          execution.approved = true;
        } else {
          execution.approved = true;
        }

        const result = await executeTool(tc.function.name, args);
        execution.result = result.result;
        execution.success = result.success;

        if (result.success) {
          allFailed = false;
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result.result,
        });

        onEvent({ type: 'tool_done', execution });
      }

      // Track consecutive all-fail rounds to prevent infinite loops
      if (allFailed) {
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          onEvent({ type: 'error', message: 'Multiple consecutive tool failures. Stopping to prevent loop.' });
          break;
        }
      } else {
        consecutiveFailures = 0;
      }

      continue;
    } else {
      if (fullContent) {
        messages.push({ role: 'assistant', content: fullContent });
      }
      onEvent({ type: 'done', content: fullContent });
      break;
    }
  }
}
