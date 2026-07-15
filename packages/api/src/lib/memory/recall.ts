/**
 * Memory Recall Pipeline Step
 * Runs BEFORE the LLM call to inject only relevant memories into context.
 * Uses hybrid search: vector similarity (65%) + BM25-style keyword scoring (35%).
 */

import { getCachedOrGenerateEmbedding } from './embedding-cache.js';
import { searchByVector } from './vector-search.js';
import { UserMemory, type IUserMemory, type MemoryType } from '../../models/user-memory.js';

export interface RecalledMemory {
  title: string;
  summary: string;
  type?: MemoryType;
  score: number;
}

/**
 * Recall only the most relevant memories for the current user message.
 * If the user has fewer than `topK` memories, returns all of them.
 */
export async function recallRelevantMemories(
  oxyUserId: string,
  userMessage: string,
  topK: number = 7
): Promise<RecalledMemory[]> {
  const memory = await UserMemory.findOne({ oxyUserId }).lean() as IUserMemory | null;
  if (!memory?.memories?.length) return [];
  if (memory.settings?.recallEnabled === false) return [];

  // If few memories, return all (no point in searching)
  if (memory.memories.length <= topK) {
    return memory.memories.map(m => ({
      title: m.title,
      summary: m.summary,
      type: m.type,
      score: 1.0,
    }));
  }

  // ── Step 1: Vector search ──────────────────────────────────────────
  const queryEmbedding = await getCachedOrGenerateEmbedding(userMessage);
  const vectorScores = new Map<string, number>();

  if (queryEmbedding) {
    const results = await searchByVector(oxyUserId, queryEmbedding, topK * 2);
    for (const r of results) {
      vectorScores.set(r.memoryKey, r.score);
    }
  }

  // ── Step 2: BM25-style keyword scoring ─────────────────────────────
  const terms = userMessage
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 2);

  const keywordScores = new Map<string, number>();
  const avgDocLen = 50; // approximate average memory length in chars
  const k1 = 1.2;

  if (terms.length > 0) {
    for (const mem of memory.memories) {
      const doc = `${mem.title} ${mem.summary}`.toLowerCase();
      let rawScore = 0;

      for (const term of terms) {
        const tf = doc.split(term).length - 1;
        if (tf > 0) {
          // Simplified IDF: log(N / (1 + df)), approximated
          const idf = Math.log(memory.memories.length / (1 + terms.length));
          rawScore += tf * Math.max(idf, 0.1);
        }
      }

      if (rawScore > 0) {
        // BM25 length normalization
        const normalizedScore = rawScore / (rawScore + k1 * (doc.length / avgDocLen));
        keywordScores.set(mem.title, normalizedScore);
      }
    }
  }

  // ── Step 3: Hybrid fusion (65% vector + 35% keyword) ──────────────
  const fused = new Map<string, number>();

  for (const [title, score] of vectorScores) {
    fused.set(title, (fused.get(title) || 0) + score * 0.65);
  }
  for (const [title, score] of keywordScores) {
    fused.set(title, (fused.get(title) || 0) + score * 0.35);
  }

  // If neither search produced results, fall back to most recent memories
  if (fused.size === 0) {
    return memory.memories.slice(-topK).map(m => ({
      title: m.title,
      summary: m.summary,
      type: m.type,
      score: 0.5,
    }));
  }

  // Sort by score and return top K with full data
  return Array.from(fused.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([title, score]) => {
      const mem = memory.memories.find(m => m.title === title);
      return mem ? { title: mem.title, summary: mem.summary, type: mem.type, score } : null;
    })
    .filter(Boolean) as RecalledMemory[];
}
