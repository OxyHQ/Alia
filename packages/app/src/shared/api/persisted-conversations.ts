import type { Conversation, Message } from '@gemies/sdk/model';
import type { PersistedRootBound } from '@oxy.so/services/ui/client';

/**
 * How much of a conversation survives a restart, so reopening one draws its latest messages at once
 * (and refreshes them behind) instead of a skeleton (docs/instant-loading.md).
 *
 * Bounded three ways, because the cache lives in localStorage (about 5 MB for the whole origin) and
 * in AsyncStorage on a phone:
 *  - the {@link MAX_PERSISTED_CONVERSATIONS} most recently updated conversations;
 *  - each with its last {@link MAX_PERSISTED_MESSAGES} messages, never a turn still streaming or
 *    not yet stored by the server (`isStreaming`, `unsaved`): a restart must not show a half-written
 *    reply as if it were the answer;
 *  - text only: an image part can be a data URL (megabytes) or a signed URL (expired by the next
 *    visit), so it is left to the refresh; and at most {@link MAX_PERSISTED_BYTES} per conversation,
 *    dropping the oldest messages first.
 *
 * Per account, like the rest of `ALIA_ACCOUNT_QUERIES`: another account on the device never reads
 * it, an account switch drops it from memory and a sign-out deletes it.
 */
export const MAX_PERSISTED_CONVERSATIONS = 20;
export const MAX_PERSISTED_MESSAGES = 40;
export const MAX_PERSISTED_BYTES = 150_000;

function textOnly(message: Message): Message {
  if (typeof message.content === 'string') return message;
  const text = message.content.filter((part) => part.type === 'text');
  return text.length === message.content.length ? message : { ...message, content: text };
}

export function trimConversation(data: unknown): unknown {
  const conversation = data as Conversation;
  if (!conversation || !Array.isArray(conversation.messages)) return data;
  let messages = conversation.messages
    .filter((message) => !message.isStreaming && !message.unsaved)
    .slice(-MAX_PERSISTED_MESSAGES)
    .map(textOnly);
  let trimmed: Conversation = { ...conversation, messages };
  while (messages.length > 1 && JSON.stringify(trimmed).length > MAX_PERSISTED_BYTES) {
    messages = messages.slice(Math.ceil(messages.length / 4));
    trimmed = { ...conversation, messages };
  }
  return trimmed;
}

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/** JSON keeps no `Date`: a restored conversation gets its `createdAt` and `updatedAt` back. */
export function reviveConversation(data: unknown): unknown {
  const conversation = data as Conversation;
  if (!conversation || typeof conversation !== 'object') return data;
  return {
    ...conversation,
    createdAt: asDate(conversation.createdAt),
    updatedAt: asDate(conversation.updatedAt),
  };
}

export const PERSISTED_CONVERSATION: PersistedRootBound = {
  maxQueries: MAX_PERSISTED_CONVERSATIONS,
  trim: trimConversation,
  revive: reviveConversation,
};
