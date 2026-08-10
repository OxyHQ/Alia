/**
 * Vector Search for Memory
 * Computes cosine similarity between query embedding and stored embeddings.
 *
 * The similarity is computed HERE, in JavaScript, over arrays loaded from
 * `double precision[]`. There is no vector operator, no index scan and no
 * distance ordering in SQL — see `db/memory/memoryEmbeddingRepository.ts`.
 *
 * ## The model that used to live here
 *
 * `MemoryEmbedding` was declared inline at the top of this file, which is why a
 * census over `src/models/` could not see it. It was also EXPORTED, and
 * re-exported by `lib/memory/index.ts` — so "declared inline" did not by itself
 * establish that nothing else used it. What established it was checking: no
 * consumer ever destructured `MemoryEmbedding` from either module, so moving the
 * store cost zero call-site edits outside this file.
 */

import { getDb } from '../../db/index.js';
import {
  deleteMemoryEmbedding as deleteRow,
  listMemoryEmbeddings,
  upsertMemoryEmbedding as upsertRow,
} from '../../db/memory/memoryEmbeddingRepository.js';
import { log } from '../logger.js';

/**
 * Cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Store or update embedding for a memory
 *
 * The `catch` is deliberate and pre-existing: embedding a memory is best-effort
 * decoration on a save that has already succeeded, and every caller invokes it
 * from a detached `.then()` chain. The repository does NOT swallow — the choice
 * to degrade rather than fail is made here, where the caller's intent is known.
 */
export async function upsertMemoryEmbedding(
  oxyUserId: string,
  memoryKey: string,
  embedding: number[]
): Promise<void> {
  try {
    await upsertRow(getDb(), oxyUserId, memoryKey, embedding);
  } catch (error) {
    log.memory.error({ err: error }, 'Error upserting embedding');
  }
}

/**
 * Delete embedding for a memory
 */
export async function deleteMemoryEmbedding(
  oxyUserId: string,
  memoryKey: string
): Promise<void> {
  try {
    await deleteRow(getDb(), oxyUserId, memoryKey);
  } catch (error) {
    log.memory.error({ err: error }, 'Error deleting embedding');
  }
}

// ── Per-user embedding cache ──────────────────────────────────────────
// Avoids reloading all embeddings from the database on every search within
// the same conversation. TTL-based with write-through invalidation.

interface UserEmbeddingCacheEntry {
  embeddings: Array<{ memoryKey: string; embedding: number[] }>;
  loadedAt: number;
}

const userEmbeddingCache = new Map<string, UserEmbeddingCacheEntry>();
const USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHED_USERS = 1000;

/**
 * Invalidate cached embeddings for a user.
 * Call this whenever memories are saved, updated, or deleted.
 */
export function invalidateUserEmbeddingCache(oxyUserId: string): void {
  userEmbeddingCache.delete(oxyUserId);
}

/**
 * Search memories by semantic similarity.
 * Uses per-user cache to avoid database round-trips within the TTL window.
 */
export async function searchByVector(
  oxyUserId: string,
  queryEmbedding: number[],
  topK: number = 5
): Promise<{ memoryKey: string; score: number }[]> {
  try {
    let cached = userEmbeddingCache.get(oxyUserId);

    if (!cached || Date.now() - cached.loadedAt > USER_CACHE_TTL_MS) {
      const embeddings = await listMemoryEmbeddings(getDb(), oxyUserId);
      if (embeddings.length === 0) return [];

      cached = {
        embeddings: embeddings.map(e => ({ memoryKey: e.memoryKey, embedding: e.embedding })),
        loadedAt: Date.now(),
      };

      // Evict oldest if at capacity
      if (userEmbeddingCache.size >= MAX_CACHED_USERS) {
        const oldestKey = userEmbeddingCache.keys().next().value;
        if (oldestKey) userEmbeddingCache.delete(oldestKey);
      }
      userEmbeddingCache.set(oxyUserId, cached);
    }

    if (cached.embeddings.length === 0) return [];

    const scored = cached.embeddings.map(e => ({
      memoryKey: e.memoryKey,
      score: cosineSimilarity(queryEmbedding, e.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  } catch (error) {
    log.memory.error({ err: error }, 'Error searching');
    return [];
  }
}
