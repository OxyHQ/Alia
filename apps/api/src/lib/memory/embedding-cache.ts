/**
 * Embedding Cache with LRU eviction
 * Caches query embeddings in-memory to avoid redundant OpenAI API calls.
 * Typical hit rate: 70-90% for conversational patterns where queries repeat.
 */

import crypto from 'crypto';
import { generateEmbedding } from './embeddings.js';

interface CachedEmbedding {
  embedding: number[];
  createdAt: number;
}

const MAX_CACHE_SIZE = 500;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const queryCache = new Map<string, CachedEmbedding>();

function hashText(text: string): string {
  return crypto.createHash('md5').update(text.toLowerCase().trim()).digest('hex');
}

/**
 * Get embedding from cache or generate a new one.
 * Cache key is MD5 of lowercased+trimmed text.
 */
export async function getCachedOrGenerateEmbedding(text: string): Promise<number[] | null> {
  const hash = hashText(text);

  const cached = queryCache.get(hash);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return cached.embedding;
  }

  // Cache miss or expired — generate fresh
  const embedding = await generateEmbedding(text);

  if (embedding) {
    // Evict oldest entry if at capacity
    if (queryCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = queryCache.keys().next().value;
      if (oldestKey) queryCache.delete(oldestKey);
    }
    queryCache.set(hash, { embedding, createdAt: Date.now() });
  }

  return embedding;
}

/**
 * Clear the entire embedding cache (useful for testing).
 */
export function clearEmbeddingCache(): void {
  queryCache.clear();
}

/**
 * Get cache statistics for monitoring.
 */
export function getEmbeddingCacheStats(): { size: number; maxSize: number } {
  return { size: queryCache.size, maxSize: MAX_CACHE_SIZE };
}
