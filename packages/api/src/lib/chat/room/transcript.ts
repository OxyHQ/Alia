/**
 * What a group room's members read: the words of a message and the conversation before the
 * person's last message, shaped for an agent turn (`lib/tools/agent-turn.ts`).
 */

import type { AgentTurnMessage } from '../../tools/agent-turn.js';

/** How much of the conversation a member reads: enough to follow it, bounded for cost. */
const HISTORY_MESSAGES = 24;
const HISTORY_CHARS = 4_000;

/** A message as the request or the store carries it: text, or parts of which the text ones count. */
export interface GroupInputMessage {
  readonly id?: string;
  readonly role: string;
  readonly content?: unknown;
  readonly agentInfo?: { readonly name: string } | null;
}

/** The words of a message's content: a string as it is, else its text parts joined. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part: unknown) =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
        ? [(part as { text: string }).text]
        : [],
    )
    .join('\n');
}

/** What the person just said: the last user message, or nothing. */
export function lastUserText(messages: readonly GroupInputMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === 'user') return textOf(message.content).trim();
  }
  return '';
}

/**
 * What a member reads before the person's last message: the earlier turns, oldest first. A member's
 * reply is attributed by name (`Nadia: …`) so each agent knows who said what in a conversation with
 * several of them; the person's messages are as they were.
 */
export function historyForMembers(messages: readonly GroupInputMessage[]): AgentTurnMessage[] {
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  const earlier = lastUser === -1 ? messages : messages.slice(0, lastUser);
  return earlier
    .flatMap((message): AgentTurnMessage[] => {
      if (message.role !== 'user' && message.role !== 'assistant') return [];
      const text = textOf(message.content).trim().slice(0, HISTORY_CHARS);
      if (text === '') return [];
      const named =
        message.role === 'assistant' && message.agentInfo
          ? `${message.agentInfo.name}: ${text}`
          : text;
      return [{ role: message.role, content: named }];
    })
    .slice(-HISTORY_MESSAGES);
}
