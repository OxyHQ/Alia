/** Durable scheduling admission: feedback waits for substantive turns, including unsaved ones. */
import { getDb } from '../../db/index.js';
import {
  markConversationActivity,
  clearConversationActivity,
  isConversationActive,
} from '../../db/chat/reactionRepository.js';

export const markConversationActive = (userId: string, conversationId: string, id: string) =>
  markConversationActivity(getDb(), userId, conversationId, id);
export const clearConversationActive = (userId: string, conversationId: string, id: string) =>
  clearConversationActivity(getDb(), userId, conversationId, id);
export const conversationIsActive = (userId: string, conversationId: string) =>
  isConversationActive(getDb(), userId, conversationId);

/** Renew long direct turns; stop waits for the last renewal before clearing its own admission. */
export async function holdConversationActivity(
  userId: string,
  conversationId: string,
  id: string,
  onLost: () => void,
  options?: { readonly clearOnStop?: boolean },
): Promise<() => Promise<void>> {
  await markConversationActive(userId, conversationId, id);
  let renewing: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = markConversationActive(userId, conversationId, id)
      .catch(onLost)
      .finally(() => {
        renewing = null;
      });
  }, 30_000);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await renewing;
    if (options?.clearOnStop !== false) await clearConversationActive(userId, conversationId, id);
  };
}
