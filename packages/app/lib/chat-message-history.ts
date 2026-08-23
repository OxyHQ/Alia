import type { Message } from '@/lib/hooks/use-conversations';
import type { ToolInvocation } from '@/lib/types/messages';

/** Message shape accepted by the chat-completions endpoint. */
export interface OutboundMessage {
  role: string;
  content: Message['content'];
  toolInvocations?: Array<{
    toolCallId: string;
    toolName: string;
    state: ToolInvocation['state'];
    args?: Record<string, unknown>;
    result?: unknown;
  }>;
}

function formatOutboundMessage(message: Message): OutboundMessage {
  const outbound: OutboundMessage = {
    role: message.role,
    content: message.content,
  };

  if (message.role === 'assistant' && message.toolInvocations?.length) {
    outbound.toolInvocations = message.toolInvocations.map((invocation) => ({
      toolCallId: invocation.toolCallId,
      toolName: invocation.toolName,
      state: invocation.state,
      args: invocation.args,
      result: invocation.result,
    }));
  }

  return outbound;
}

/** Build a turn from the history captured before optimistic UI updates. */
export function buildOutboundMessages(
  historySnapshot: readonly Message[],
  userMessage: Message,
): OutboundMessage[] {
  return [...historySnapshot, userMessage].map(formatOutboundMessage);
}

function sameContent(a: Message['content'], b: Message['content']): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function isEmptyAssistantPlaceholder(message: Message | undefined): boolean {
  return message?.role === 'assistant'
    && message.content === ''
    && !message.thinking
    && !message.toolInvocations?.length
    && !message.agentInfo
    && !message.audioUrl;
}

/**
 * Hide histories written by the former optimistic-send race.
 *
 * That race persisted one exact sequence: user, empty assistant placeholder,
 * the same user again. Only that signature is collapsed; intentional repeated
 * prompts separated by a real assistant response remain untouched. The next
 * successful turn rewrites divergent server history from this clean view.
 */
export function normalizeConversationMessages(messages: readonly Message[]): Message[] {
  const normalized: Message[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index];
    const placeholder = messages[index + 1];
    const duplicate = messages[index + 2];

    if (
      current.role === 'user'
      && isEmptyAssistantPlaceholder(placeholder)
      && duplicate?.role === 'user'
      && sameContent(current.content, duplicate.content)
    ) {
      normalized.push(current);
      index += 2;
      continue;
    }

    normalized.push(current);
  }

  return normalized;
}
