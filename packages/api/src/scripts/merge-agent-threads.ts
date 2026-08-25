#!/usr/bin/env bun
/**
 * Fold several conversations with one agent into the single thread they should
 * have been — the case migration 0046 deliberately refuses.
 *
 * ## Why this is a script and not part of the migration
 *
 * 0046 makes `(oxy_user_id, agent_id)` unique, and it resolves the duplicates
 * it can resolve without losing anything: an agent-linked conversation with no
 * messages and no breaks is unlinked. What it will not do is decide between two
 * conversations that BOTH hold real history — that is somebody's data, and a
 * migration that picked a winner would pick one nobody chose.
 *
 * So the migration refuses, the deploy rolls back with the task's logs, and
 * this exists so that "somebody decides" is one command rather than an
 * afternoon of hand-written SQL against production.
 *
 * ## Merge, not choose, and by MESSAGE time
 *
 * The two conversations are not two subjects. They are one conversation with
 * one agent, split only because `POST /conversations/new` minted a row per
 * VISIT — the behaviour the permanent thread exists to end. So the answer is to
 * merge them, and nothing is deleted: every message of every conversation for
 * the pair survives, in the order it was actually said.
 *
 * Ordered by the MESSAGES' `created_at`, not by their conversations'. Those two
 * disagree in the real data this was written for — the oldest conversation held
 * the newest turns — so ordering by conversation would put a reply before the
 * question it answered. `seq` is reassigned over the union, because it is only
 * unique within a conversation and both sets start at zero.
 *
 * ## What survives is the OLDEST conversation of the pair
 *
 * Not the largest and not the newest: the oldest is the one whose id a person
 * may have bookmarked, and `resolveAgentThread` picks the oldest too, so the
 * thread this produces is the thread the product would have resolved anyway.
 *
 * ## It refuses rather than guessing, in two places
 *
 * A conversation carrying a `canvas_sessions` row is not merged: that table is
 * unique per `(oxy_user_id, conversation_id)` and folding two canvases means
 * discarding one. Nothing writes that table today, so this is a guard rather
 * than a case — and a guard is what makes the "nothing is deleted" claim true
 * without qualification.
 *
 * Reporting is the DEFAULT. Merging takes `--merge`, so reading what it would
 * do costs nothing and cannot be done by accident.
 *
 * Usage, against whatever `DATABASE_URL` points at — which in practice is
 * PRODUCTION, through the SSM tunnel:
 *
 *   bun src/scripts/merge-agent-threads.ts             # report only
 *   bun src/scripts/merge-agent-threads.ts --merge     # do it
 */

import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../db/index.js';
import { canvasSessions, conversationBreaks, conversations, messages } from '../db/schema/chat.js';

const MERGE = process.argv.includes('--merge');

interface Duplicate {
  readonly oxyUserId: string;
  readonly agentId: string;
  readonly conversationIds: readonly string[];
}

/** Every `(oxy_user_id, agent_id)` pair holding more than one conversation. */
async function findDuplicates(db: ApiDatabase): Promise<Duplicate[]> {
  const rows = await db
    .select({
      oxyUserId: conversations.oxyUserId,
      agentId: sql<string>`${conversations.agentId}`,
      conversationIds: sql<string[]>`array_agg(${conversations.conversationId} order by ${conversations.createdAt}, ${conversations.id})`,
    })
    .from(conversations)
    .where(isNotNull(conversations.agentId))
    .groupBy(conversations.oxyUserId, conversations.agentId)
    .having(sql`count(*) > 1`);
  return rows;
}

/** How many messages, breaks and canvases a conversation holds. */
async function contentOf(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
): Promise<{ messages: number; breaks: number; canvases: number }> {
  const one = async (table: typeof messages | typeof conversationBreaks | typeof canvasSessions) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(and(eq(table.oxyUserId, oxyUserId), eq(table.conversationId, conversationId)));
    return row?.n ?? 0;
  };
  return {
    messages: await one(messages),
    breaks: await one(conversationBreaks),
    canvases: await one(canvasSessions),
  };
}

/**
 * Fold every conversation of one pair into its oldest, in one transaction.
 *
 * The whole pair moves or none of it does. A half-merged thread — some messages
 * repointed, the conversation rows still separate — is a state nothing in the
 * product knows how to read and nothing here could resume from.
 */
async function merge(db: ApiDatabase, duplicate: Duplicate): Promise<number> {
  const [survivor, ...absorbed] = duplicate.conversationIds;

  return db.transaction(async (tx) => {
    /**
     * Every message of the pair, in the order it was SAID.
     *
     * `created_at` first because that is the only order true of the union;
     * `conversation_id` and `seq` break a same-millisecond tie so the result is
     * total rather than whatever the planner happened to return.
     */
    const all = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.oxyUserId, duplicate.oxyUserId),
          sql`${messages.conversationId} in ${duplicate.conversationIds}`,
        ),
      )
      .orderBy(asc(messages.createdAt), asc(messages.conversationId), asc(messages.seq));

    /**
     * `seq` is cleared before it is reassigned.
     *
     * `messages_oxy_user_conversation_seq_key` is unique on
     * `(oxy_user_id, conversation_id, seq)`, and both sets of messages start at
     * zero — so repointing them one by one collides on the first row. NULL is
     * outside the partial index, which is what makes the two-pass write legal.
     */
    await tx
      .update(messages)
      .set({ conversationId: survivor, seq: null })
      .where(
        and(
          eq(messages.oxyUserId, duplicate.oxyUserId),
          sql`${messages.conversationId} in ${duplicate.conversationIds}`,
        ),
      );

    for (const [index, row] of all.entries()) {
      await tx.update(messages).set({ seq: index }).where(eq(messages.id, row.id));
    }

    // Breaks move too: a mark is a moment in the thread, and the thread is now
    // one. They carry their own timestamps, so no reordering is needed.
    await tx
      .update(conversationBreaks)
      .set({ conversationId: survivor })
      .where(
        and(
          eq(conversationBreaks.oxyUserId, duplicate.oxyUserId),
          sql`${conversationBreaks.conversationId} in ${duplicate.conversationIds}`,
        ),
      );

    // The emptied conversation rows go. They hold nothing now — every child was
    // repointed above — so this deletes no content.
    for (const conversationId of absorbed) {
      await tx
        .delete(conversations)
        .where(
          and(
            eq(conversations.oxyUserId, duplicate.oxyUserId),
            eq(conversations.conversationId, conversationId),
          ),
        );
    }

    return all.length;
  });
}

async function main(): Promise<void> {
  const db = connectPostgres(process.env.DATABASE_URL);
  if (!db) throw new Error('DATABASE_URL is required');

  const duplicates = await findDuplicates(db);
  if (duplicates.length === 0) {
    console.info('No pair holds more than one conversation. Nothing to do.');
    return;
  }

  console.info(`${duplicates.length} pair(s) hold more than one conversation.\n`);

  let blocked = 0;
  for (const duplicate of duplicates) {
    console.info(`user ${duplicate.oxyUserId}  agent ${duplicate.agentId}`);
    let canvases = 0;
    for (const conversationId of duplicate.conversationIds) {
      const content = await contentOf(db, duplicate.oxyUserId, conversationId);
      canvases += content.canvases;
      console.info(
        `  ${conversationId}  ${content.messages} message(s), ${content.breaks} break(s), ${content.canvases} canvas(es)`,
      );
    }

    if (canvases > 0) {
      // See the file comment: folding two canvases means discarding one, and
      // this script's whole claim is that it discards nothing.
      console.info('  SKIPPED: a canvas session is attached. Resolve this pair by hand.\n');
      blocked += 1;
      continue;
    }

    if (!MERGE) {
      console.info(`  would merge into ${duplicate.conversationIds[0]} (the oldest)\n`);
      continue;
    }

    const moved = await merge(db, duplicate);
    console.info(`  merged ${moved} message(s) into ${duplicate.conversationIds[0]}\n`);
  }

  if (!MERGE) console.info('Report only. Pass --merge to apply.');
  if (blocked > 0) console.info(`${blocked} pair(s) need a hand.`);
}

main().then(
  async () => {
    await closePostgres();
    process.exit(0);
  },
  async (error: unknown) => {
    console.error(error);
    await closePostgres();
    process.exit(1);
  },
);
