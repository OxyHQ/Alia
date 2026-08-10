/**
 * Memory embeddings, on Postgres.
 *
 * One row per `(oxy_user_id, memory_key)`, holding the vector for one
 * remembered fact. `memory_key` is a memory's title VERBATIM — see
 * `db/schema/memory.ts` for why it carries no foreign key to the entry it
 * names.
 *
 * ## Cosine similarity stays in JavaScript, and that is a decision, not an
 * omission
 *
 * `embedding` is `double precision[]`, not a pgvector column, so this
 * repository's whole obligation for the search path is to hand back the arrays
 * exactly as stored. There is no distance operator, no index scan and no
 * ordering by similarity in SQL — `lib/memory/vector-search.ts` scores in
 * JavaScript, as it always has. Moving that into SQL would be a product change
 * requiring pgvector, which is a privileged extension on the shared instance;
 * it is deliberately not part of this port.
 *
 * ## This repository does not swallow
 *
 * The Mongoose version wrapped every call in a `try/catch` that logged and
 * continued. That behaviour belongs to the CALLER — these are best-effort,
 * fire-and-forget writes from a `.then()` chain, and the decision to degrade
 * rather than fail is `vector-search.ts`'s to make. A repository that caught its
 * own errors would make "the write failed" and "the write happened" the same
 * observable, which is the failure mode this whole port is trying not to
 * reproduce.
 */

import { and, eq } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { memoryEmbeddings } from '../schema/memory';

/** One stored vector, as the search path consumes it. */
export interface StoredMemoryEmbedding {
  readonly memoryKey: string;
  readonly embedding: number[];
}

/**
 * Store this memory's vector, replacing any vector already held for it.
 *
 * The Mongo version was `updateOne(…, { $set: { embedding, updatedAt } }, {
 * upsert: true })`. `ON CONFLICT DO UPDATE` on the `(oxy_user_id, memory_key)`
 * unique is the same operation done by the server: two concurrent saves of the
 * same memory settle to one row rather than racing a read-then-write.
 *
 * ## `updatedAt` is NOT set here, and that was measured rather than assumed
 *
 * The source's explicit `$set: { updatedAt }` looks like it has to be carried
 * over, because the column's own default applies on INSERT only. It does not:
 * `@oxyhq/db`'s `updatedAt()` carries `$onUpdate`, and drizzle applies that to
 * an `onConflictDoUpdate` set as well as to `db.update()`. Compiling both forms
 * shows the conflict clause emitting `"updated_at" = $6` with the column named
 * nowhere in the `set`.
 *
 * Writing it anyway is worse than redundant — it swaps the JS `Date` the house
 * builder intends for the SERVER clock, so the two disagree under any skew.
 * Recorded because a mutation deleting the explicit set SURVIVED, and the
 * honest reading of that was dead code, not a weak assertion.
 */
export async function upsertMemoryEmbedding(
  db: ApiDatabase,
  oxyUserId: string,
  memoryKey: string,
  embedding: number[],
): Promise<void> {
  await db
    .insert(memoryEmbeddings)
    .values({ oxyUserId, memoryKey, embedding })
    .onConflictDoUpdate({
      target: [memoryEmbeddings.oxyUserId, memoryEmbeddings.memoryKey],
      set: { embedding },
    });
}

/**
 * Forget this memory's vector.
 *
 * Reports how many rows went, which the Mongoose caller discarded. It is
 * returned rather than dropped because a rename calls this with the PREVIOUS
 * title (`lib/tools/user-memory.ts:195`) and a zero there means the old
 * embedding was left behind — the one orphaning `db/schema/memory.ts` says
 * nothing in the schema can prevent.
 */
export async function deleteMemoryEmbedding(
  db: ApiDatabase,
  oxyUserId: string,
  memoryKey: string,
): Promise<number> {
  const result = await db
    .delete(memoryEmbeddings)
    .where(
      and(eq(memoryEmbeddings.oxyUserId, oxyUserId), eq(memoryEmbeddings.memoryKey, memoryKey)),
    );
  /**
   * Off `count`, never `rows.length`: for a DELETE the returned row set is
   * empty either way, so `rows.length` is a plausible, always-zero answer.
   */
  return result.count;
}

/**
 * Every vector this user has, for the in-JavaScript similarity scan.
 *
 * No ordering and no limit: the caller scores all of them and takes the top K,
 * which is what it did against Mongo. Selecting the two columns rather than the
 * row keeps the id and timestamps off a payload that is already the largest
 * read in the domain.
 */
export async function listMemoryEmbeddings(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<StoredMemoryEmbedding[]> {
  return db
    .select({ memoryKey: memoryEmbeddings.memoryKey, embedding: memoryEmbeddings.embedding })
    .from(memoryEmbeddings)
    .where(eq(memoryEmbeddings.oxyUserId, oxyUserId));
}
