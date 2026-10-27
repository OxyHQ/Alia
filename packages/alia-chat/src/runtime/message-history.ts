import type { Message, ToolInvocation } from './types';

/** Message shape accepted by the chat-completions endpoint. */
export interface OutboundMessage {
  /**
   * The id this screen draws the message under. The server stores the turn
   * with the ids it was sent (`packages/api/src/lib/conversation-saver.ts`), so
   * a vote or a read-aloud addressed by `Message.id` finds the row without a
   * reload in between.
   */
  id: string;
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
    id: message.id,
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

/**
 * The id of the `index`-th consulted agent's answer (`alia.agent_start`, in the
 * order the consultations started) in the turn whose reply is `assistantMessageId`.
 *
 * Derived, not received: the frames name a consultation (`consultId`), not a
 * message. The server stores the same answer under the same derivation
 * (`conversation-saver.ts` `agentMessageId`).
 */
export function agentMessageId(assistantMessageId: string, index: number): string {
  return `${agentMessagePrefix(assistantMessageId)}${index}`;
}

/** Whether `id` is one of the agent answers {@link agentMessageId} names for this reply. */
export function isAgentMessageOf(id: string, assistantMessageId: string): boolean {
  return id.startsWith(agentMessagePrefix(assistantMessageId));
}

function agentMessagePrefix(assistantMessageId: string): string {
  return `${assistantMessageId}-agent-`;
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
  return (
    message?.role === 'assistant' &&
    message.content === '' &&
    !message.thinking &&
    !message.toolInvocations?.length &&
    !message.agentInfo
  );
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
  // A host's client context travels as a system message and is never part of the thread.
  messages = messages.filter((message) => message.role !== 'system');

  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index] as Message;
    const placeholder = messages[index + 1];
    const duplicate = messages[index + 2];

    if (
      current.role === 'user' &&
      isEmptyAssistantPlaceholder(placeholder) &&
      duplicate?.role === 'user' &&
      sameContent(current.content, duplicate.content)
    ) {
      normalized.push(current);
      index += 2;
      continue;
    }

    normalized.push(current);
  }

  return normalized;
}
