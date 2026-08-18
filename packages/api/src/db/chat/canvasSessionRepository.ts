/**
 * The canvas attached to one conversation.
 *
 * ## This table has NO WRITER, and that is a measurement rather than an omission
 *
 * `lib/tools/canvas.ts` mints a component and hands it to the model; `socket.ts`
 * broadcasts one over `canvas-update`. Neither stores anything, and nothing else
 * in the package inserts or updates a row — so the three functions below are two
 * reads and a delete, which is the complete surface.
 *
 * Two consequences a reader should not have to rediscover:
 *
 * - `socket.ts`'s `subscribe-canvas` gate cannot pass today. It joins the room
 *   only if a row exists, and none does. That is the behaviour being ported, not
 *   a bug introduced here — a room join that started succeeding because the port
 *   "fixed" the lookup would be a new subscription path nobody reviewed.
 * - `GET /canvas/:conversationId` answers `{ components: [] }` for every
 *   conversation, and did before.
 *
 * There is deliberately no `upsertCanvasSession` waiting for a caller. An unused
 * write against a table whose shape nothing exercises is the least reviewed code
 * in a package and the first thing a future feature would reach for.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { CanvasComponent } from '../../domain/canvas-session.js';
import type { ApiDatabase } from '../index';
import { canvasSessions } from '../schema/chat';

/**
 * The components of one conversation's canvas, for its owner.
 *
 * `undefined` means there is no canvas session; an EMPTY ARRAY means there is
 * one holding nothing. The route collapses both to `{ components: [] }`, and
 * that is its decision to make — collapsing them here would leave a caller
 * unable to tell "no canvas" from "an empty canvas" ever again.
 *
 * The owner is part of the WHERE, so another account's canvas is
 * indistinguishable from a missing one.
 */
export async function findCanvasComponents(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
): Promise<CanvasComponent[] | undefined> {
  const [row] = await db
    .select({ components: canvasSessions.components })
    .from(canvasSessions)
    .where(
      and(
        eq(canvasSessions.oxyUserId, oxyUserId),
        eq(canvasSessions.conversationId, conversationId),
      ),
    );
  return row?.components;
}

/**
 * Whether this owner has a canvas for this conversation.
 *
 * A boolean, not the row: `socket.ts` uses it only to decide whether to join a
 * room, and the source's `.select('_id')` said the same thing less clearly. A
 * gate that cannot return content cannot leak any.
 */
export async function canvasSessionExists(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(canvasSessions)
    .where(
      and(
        eq(canvasSessions.oxyUserId, oxyUserId),
        eq(canvasSessions.conversationId, conversationId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Clear one conversation's canvas, scoped to its owner.
 *
 * Reports rows removed off `count` — a DELETE's returned row set is empty
 * whether or not it deleted anything, so `rows.length` would be an always-zero
 * answer. The route answers 200 either way, exactly as `findOneAndDelete` did
 * when it matched nothing.
 */
export async function deleteCanvasSession(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
): Promise<number> {
  const result = await db
    .delete(canvasSessions)
    .where(
      and(
        eq(canvasSessions.oxyUserId, oxyUserId),
        eq(canvasSessions.conversationId, conversationId),
      ),
    );
  return result.count;
}
