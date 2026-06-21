/**
 * Vector Search for Memory
 * Computes cosine similarity between query embedding and stored embeddings.
 * Falls back to text search if embeddings are unavailable.
 */

import mongoose, { Schema, Model, Document } from 'mongoose';
import { log } from '../logger.js';

export interface IMemoryEmbedding extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  memoryKey: string;
  embedding: number[];
  updatedAt: Date;
}

const MemoryEmbeddingSchema = new Schema<IMemoryEmbedding>({
  oxyUserId: { type: Schema.Types.ObjectId, required: true, index: true },
  memoryKey: { type: String, required: true },
  embedding: { type: [Number], required: true },
}, { timestamps: true });

// Compound index for unique user+key
MemoryEmbeddingSchema.index({ oxyUserId: 1, memoryKey: 1 }, { unique: true });

export const MemoryEmbedding: Model<IMemoryEmbedding> =
  mongoose.models.MemoryEmbedding || mongoose.model<IMemoryEmbedding>('MemoryEmbedding', MemoryEmbeddingSchema);

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
 */
export async function upsertMemoryEmbedding(
  oxyUserId: string,
  memoryKey: string,
  embedding: number[]
): Promise<void> {
  try {
    await MemoryEmbedding.updateOne(
      { oxyUserId, memoryKey },
      { $set: { embedding, updatedAt: new Date() } },
      { upsert: true }
    );
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
    await MemoryEmbedding.deleteOne({ oxyUserId, memoryKey });
  } catch (error) {
    log.memory.error({ err: error }, 'Error deleting embedding');
  }
}

// ── Per-user embedding cache ──────────────────────────────────────────
// Avoids reloading all embeddings from MongoDB on every search within
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
 * Uses per-user cache to avoid MongoDB round-trips within the TTL window.
 */
export async function searchByVector(
  oxyUserId: string,
  queryEmbedding: number[],
  topK: number = 5
): Promise<{ memoryKey: string; score: number }[]> {
  try {
    let cached = userEmbeddingCache.get(oxyUserId);

    if (!cached || Date.now() - cached.loadedAt > USER_CACHE_TTL_MS) {
      const embeddings = await MemoryEmbedding.find({ oxyUserId }).lean();
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
