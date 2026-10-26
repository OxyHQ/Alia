import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { chatTurnControls } from '../schema/chat-turn-controls';
import { CHAT_TURN_RETENTION_MS, type ChatTurnState } from '../../domain/chat-turn-control';

export interface TurnIdentity {
  id: string;
  authorityKey: string;
  /** The conversation known when the request was constructed, stable across retries. */
  conversationId: string | null;
}

export class TurnControlError extends Error {
  constructor(
    public readonly code:
      | 'turn_not_found'
      | 'turn_already_started'
      | 'turn_cancelled'
      | 'turn_control_unavailable'
      | 'turn_control_unsupported',
  ) {
    super(code);
  }
}

export function turnControlRepository(db: ApiDatabase) {
  const identityMatches = (row: typeof chatTurnControls.$inferSelect, identity: TurnIdentity) =>
    row.authorityKey === identity.authorityKey && row.conversationId === identity.conversationId;

  async function admitOrCancel(
    identity: TurnIdentity,
    owner: string | null,
  ): Promise<ChatTurnState> {
    return db.transaction(async (tx) => {
      // A wedged control store must not leave an active model running indefinitely.
      await tx.execute(sql`SET LOCAL statement_timeout = '1500ms'`);
      await tx.execute(sql`SET LOCAL lock_timeout = '1000ms'`);
      const inserted = await tx
        .insert(chatTurnControls)
        .values({
          ...identity,
          owner,
          state: owner === null ? 'cancelled' : 'running',
          deadline: sql`now() + interval '80 seconds'`,
          expiresAt: sql`now() + ${CHAT_TURN_RETENTION_MS} * interval '1 millisecond'`,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted.length) return inserted[0].state;
      const [row] = await tx
        .select()
        .from(chatTurnControls)
        .where(eq(chatTurnControls.id, identity.id))
        .for('update');
      if (!row || !identityMatches(row, identity) || row.expiresAt.getTime() <= Date.now()) {
        throw new TurnControlError('turn_not_found');
      }
      if (owner !== null) {
        throw new TurnControlError(
          row.state === 'cancelled' ? 'turn_cancelled' : 'turn_already_started',
        );
      }
      if (row.state !== 'running') return row.state;
      await tx
        .update(chatTurnControls)
        .set({ state: 'cancelled' })
        .where(eq(chatTurnControls.id, identity.id));
      return 'cancelled';
    });
  }

  return {
    claim: (identity: TurnIdentity, owner: string) => admitOrCancel(identity, owner),
    cancel: (identity: TurnIdentity) => admitOrCancel(identity, null),
    async readActive(ids: string[]) {
      if (!ids.length) return [];
      return db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '1500ms'`);
        return tx
          .select({
            id: chatTurnControls.id,
            owner: chatTurnControls.owner,
            state: chatTurnControls.state,
          })
          .from(chatTurnControls)
          .where(and(inArray(chatTurnControls.id, ids), gt(chatTurnControls.deadline, sql`now()`)));
      });
    },
    /** The provider finished. A simultaneous Stop must win BEFORE this commit point. */
    async beginFinish(identity: TurnIdentity, owner: string): Promise<void> {
      const rows = await db
        .update(chatTurnControls)
        .set({ state: 'finishing' })
        .where(
          and(
            eq(chatTurnControls.id, identity.id),
            eq(chatTurnControls.authorityKey, identity.authorityKey),
            eq(chatTurnControls.owner, owner),
            eq(chatTurnControls.state, 'running'),
            gt(chatTurnControls.deadline, sql`now()`),
          ),
        )
        .returning({ id: chatTurnControls.id });
      if (!rows.length) throw new TurnControlError('turn_cancelled');
    },
    async finish(identity: TurnIdentity, owner: string, success: boolean): Promise<void> {
      await db
        .update(chatTurnControls)
        .set({ state: success ? 'completed' : 'failed' })
        .where(
          and(
            eq(chatTurnControls.id, identity.id),
            eq(chatTurnControls.authorityKey, identity.authorityKey),
            eq(chatTurnControls.owner, owner),
            success
              ? eq(chatTurnControls.state, 'finishing')
              : sql`${chatTurnControls.state} IN ('running', 'finishing')`,
          ),
        );
    },
  };
}

export type TurnControlRepository = ReturnType<typeof turnControlRepository>;
