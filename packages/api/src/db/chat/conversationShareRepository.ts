/**
 * Conversation share links (`conversation_shares`).
 *
 * A link is addressed two ways: by its owner and conversation (share, revoke),
 * and by the SHA-256 of its token (the public read). The token itself is never
 * stored — `db/schema/chat.ts` says why.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Executor } from '../index';
import { conversationShares } from '../schema/chat';

/** The hash a token is stored and looked up under. */
export function shareTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Share a conversation: a fresh token, valid until `expiresAt`.
 *
 * One link per conversation, so sharing again REPLACES the stored hash and the
 * previous token stops opening anything on the same statement.
 */
export async function shareConversation(
  db: Executor,
  input: { oxyUserId: string; conversationId: string; expiresAt: Date },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = shareTokenHash(token);
  const [row] = await db
    .insert(conversationShares)
    .values({
      tokenHash,
      oxyUserId: input.oxyUserId,
      conversationId: input.conversationId,
      expiresAt: input.expiresAt,
    })
    .onConflictDoUpdate({
      target: [conversationShares.oxyUserId, conversationShares.conversationId],
      set: { tokenHash, expiresAt: input.expiresAt, createdAt: sql`now()` },
    })
    .returning({ expiresAt: conversationShares.expiresAt });
  return { token, expiresAt: row.expiresAt };
}

/** Revoke a conversation's link. The number of links removed: 0 or 1. */
export async function revokeConversationShare(
  db: Executor,
  oxyUserId: string,
  conversationId: string,
): Promise<number> {
  const removed = await db
    .delete(conversationShares)
    .where(
      and(
        eq(conversationShares.oxyUserId, oxyUserId),
        eq(conversationShares.conversationId, conversationId),
      ),
    )
    .returning({ id: conversationShares.id });
  return removed.length;
}

/**
 * The conversation a live token opens, or null.
 *
 * Expiry is decided HERE, by the database clock, not left to the sweep: the
 * sweep only removes rows, and a link must stop working the moment it expires.
 */
export async function findLiveShare(
  db: Executor,
  token: string,
): Promise<{ oxyUserId: string; conversationId: string; expiresAt: Date } | null> {
  const [row] = await db
    .select({
      oxyUserId: conversationShares.oxyUserId,
      conversationId: conversationShares.conversationId,
      expiresAt: conversationShares.expiresAt,
    })
    .from(conversationShares)
    .where(
      and(
        eq(conversationShares.tokenHash, shareTokenHash(token)),
        gt(conversationShares.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  return row ?? null;
}
