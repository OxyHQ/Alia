import { and, eq, gt, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { chatHostResults } from '../schema/chat-host-results';
import { HOST_RESULT_RETENTION_MS, type HostToolOutcome } from '../../domain/chat-host-results';

/** One awaited host action: the turn that dispatched it, under the authority that started it. */
export interface HostResultKey {
  turnId: string;
  toolCallId: string;
  authorityKey: string;
}

/** What the client answered for an awaited host action. */
export interface HostResultAnswer {
  outcome: HostToolOutcome;
  detail?: string;
  result?: unknown;
}

export class HostResultError extends Error {
  constructor(public readonly code: 'host_result_not_found' | 'host_result_already_answered') {
    super(code);
  }
}

type Row = Pick<
  typeof chatHostResults.$inferSelect,
  'turnId' | 'toolCallId' | 'outcome' | 'detail' | 'result'
>;

function answerOf(row: Row): HostResultAnswer {
  return {
    outcome: row.outcome as HostToolOutcome,
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(row.result === null || row.result === undefined ? {} : { result: row.result }),
  };
}

const answered = {
  turnId: chatHostResults.turnId,
  toolCallId: chatHostResults.toolCallId,
  state: chatHostResults.state,
  outcome: chatHostResults.outcome,
  detail: chatHostResults.detail,
  result: chatHostResults.result,
};

/**
 * PostgreSQL is the only store: the answer can arrive on any replica, and the waiting turn reads
 * it from here. A row exists only while its turn waits, and is deleted when the turn reads it, when
 * the wait ends unanswered, or by the expiry sweep after a crash.
 */
export function hostResultRepository(db: ApiDatabase) {
  return {
    /** Before the action is emitted, so an answer always finds the row it answers. */
    async open(key: HostResultKey): Promise<void> {
      await db
        .insert(chatHostResults)
        .values({
          ...key,
          state: 'pending',
          expiresAt: sql`now() + ${HOST_RESULT_RETENTION_MS} * interval '1 millisecond'`,
        })
        .onConflictDoNothing();
    },

    /**
     * Record the client's answer. Another authority, an action this turn never awaited, and one no
     * longer awaited are all `host_result_not_found`; a second answer while the first is unread is
     * `host_result_already_answered`.
     */
    async answer(key: HostResultKey, answer: HostResultAnswer): Promise<void> {
      const match = and(
        eq(chatHostResults.turnId, key.turnId),
        eq(chatHostResults.toolCallId, key.toolCallId),
        eq(chatHostResults.authorityKey, key.authorityKey),
        gt(chatHostResults.expiresAt, sql`now()`),
      );
      const rows = await db
        .update(chatHostResults)
        .set({
          state: 'answered',
          outcome: answer.outcome,
          detail: answer.detail ?? null,
          result: answer.result === undefined ? null : answer.result,
          answeredAt: sql`now()`,
        })
        .where(and(match, eq(chatHostResults.state, 'pending')))
        .returning({ turnId: chatHostResults.turnId });
      if (rows.length) return;
      const [existing] = await db
        .select({ state: chatHostResults.state })
        .from(chatHostResults)
        .where(match);
      throw new HostResultError(
        existing?.state === 'answered' ? 'host_result_already_answered' : 'host_result_not_found',
      );
    },

    /** The answered rows among `keys`, deleted in the same statement that reads them. */
    async take(keys: readonly Pick<HostResultKey, 'turnId' | 'toolCallId'>[]) {
      if (!keys.length) return [];
      return db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '1500ms'`);
        const rows = await tx
          .delete(chatHostResults)
          .where(
            and(
              eq(chatHostResults.state, 'answered'),
              sql`(${chatHostResults.turnId}, ${chatHostResults.toolCallId}) IN (${sql.join(
                keys.map((key) => sql`(${key.turnId}, ${key.toolCallId})`),
                sql`, `,
              )})`,
            ),
          )
          .returning(answered);
        return rows.map((row) => ({
          turnId: row.turnId,
          toolCallId: row.toolCallId,
          answer: answerOf(row),
        }));
      });
    },

    /**
     * The wait is over: delete the row. An answer that landed after the last poll is still
     * returned, so it is not lost to the race.
     */
    async close(
      key: Pick<HostResultKey, 'turnId' | 'toolCallId'>,
    ): Promise<HostResultAnswer | null> {
      const [row] = await db
        .delete(chatHostResults)
        .where(
          and(
            eq(chatHostResults.turnId, key.turnId),
            eq(chatHostResults.toolCallId, key.toolCallId),
          ),
        )
        .returning(answered);
      return row?.state === 'answered' ? answerOf(row) : null;
    },
  };
}

export type HostResultRepository = ReturnType<typeof hostResultRepository>;
