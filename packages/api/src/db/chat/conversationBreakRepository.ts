/**
 * The "start a new conversation here" marks inside a thread.
 *
 * Keyed by `(oxy_user_id, conversation_id)` like everything else in `db/chat/`,
 * so a mark belongs to the person whose thread it is and a caller cannot read
 * or write one in somebody else's. `db/schema/chat.ts` argues why this is a
 * table rather than a `messages.role`.
 *
 * There is no update and no delete-one. A mark is a moment: it is added, and it
 * goes when the thread does. Nothing in the product edits one, so there is
 * nothing here to edit it with.
 */

import { and, asc, eq } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { conversationBreaks } from '../schema/chat';

/**
 * Mark a break at NOW, and answer when.
 *
 * The instant is the column default rather than a value this code composes, so
 * the mark is ordered by the same clock as the messages it will be merged with.
 * A client-supplied timestamp is deliberately not accepted: a break placed in
 * the past would reorder somebody's thread, and no screen has a reason to.
 */
export async function insertConversationBreak(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
): Promise<Date> {
  const [row] = await db
    .insert(conversationBreaks)
    .values({ oxyUserId, conversationId })
    .returning({ createdAt: conversationBreaks.createdAt });
  if (!row) throw new Error('conversation break insert returned no row');
  return row.createdAt;
}

/**
 * Every mark in one thread, oldest first.
 *
 * The client merges these into the message stream by timestamp, so the order
 * has to be the same one the messages come back in.
 */
export async function listConversationBreaks(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
): Promise<Date[]> {
  const rows = await db
    .select({ createdAt: conversationBreaks.createdAt })
    .from(conversationBreaks)
    .where(
      and(
        eq(conversationBreaks.oxyUserId, oxyUserId),
        eq(conversationBreaks.conversationId, conversationId),
      ),
    )
    .orderBy(asc(conversationBreaks.createdAt));
  return rows.map((row) => row.createdAt);
}

/**
 * Remove every mark in a thread, reporting how many.
 *
 * There is no foreign key to cascade through — `db/schema/chat.ts` records why
 * — so `DELETE /conversations/:id` calls this itself, exactly as it already
 * calls `deleteMessages`.
 */
export async function deleteConversationBreaks(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
): Promise<number> {
  const result = await db
    .delete(conversationBreaks)
    .where(
      and(
        eq(conversationBreaks.oxyUserId, oxyUserId),
        eq(conversationBreaks.conversationId, conversationId),
      ),
    );
  return result.count;
}
