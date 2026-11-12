import { sql } from 'drizzle-orm';
import type { Executor } from '../index';

/** Shared by feedback and all message writers; no lock depends on a replaceable row UUID. */
export async function lockMessageThread(
  db: Executor,
  userId: string,
  conversationId: string,
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([userId, conversationId])}, 0))`,
  );
}
