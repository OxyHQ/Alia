/**
 * Vector Search for Memory
 * Computes cosine similarity between query embedding and stored embeddings.
 * Falls back to text search if embeddings are unavailable.
 */

import mongoose, { Schema, Model, Document } from 'mongoose';

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
    console.error('[VectorSearch] Error upserting embedding:', error);
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
    console.error('[VectorSearch] Error deleting embedding:', error);
  }
}

/**
 * Search memories by semantic similarity.
 * Returns memory keys sorted by similarity score.
 */
export async function searchByVector(
  oxyUserId: string,
  queryEmbedding: number[],
  topK: number = 5
): Promise<{ memoryKey: string; score: number }[]> {
  try {
    const embeddings = await MemoryEmbedding.find({ oxyUserId }).lean();
    if (embeddings.length === 0) return [];

    const scored = embeddings.map(e => ({
      memoryKey: e.memoryKey,
      score: cosineSimilarity(queryEmbedding, e.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  } catch (error) {
    console.error('[VectorSearch] Error searching:', error);
    return [];
  }
}
