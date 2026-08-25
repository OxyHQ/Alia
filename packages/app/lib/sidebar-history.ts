import type { Conversation } from '@/lib/hooks/use-conversations';

/**
 * What the sidebar's History lists: everything not already shown somewhere else.
 *
 * Two exclusions, for the same reason. A conversation inside a project is listed
 * under its project. A conversation with an agent is one stretch of that agent's
 * THREAD, listed once by the agent above — without that, an agent somebody has
 * talked to five times puts five rows in History beside its single row in
 * Agents, which is the shape the permanent thread exists to replace.
 *
 * `agentId` is checked for a usable VALUE rather than against `undefined`: the
 * wire carries an explicit `null` for every ordinary conversation, so comparing
 * to `undefined` keeps all of them and hides none — and comparing to `null`
 * alone would drop the ones restored from local storage, which have neither.
 */
export function conversationsForHistory(
  conversations: readonly Conversation[],
  projects: readonly { readonly conversationIds: readonly string[] }[],
): Conversation[] {
  return conversations.filter((conversation) =>
    !conversation.agentId
    && !projects.some((project) => project.conversationIds.includes(conversation.id))
  );
}
