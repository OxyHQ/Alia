/**
 * Memory Embeddings
 * Embeddings fail closed until Kaana exposes an embedding seam.
 */

import { kaanaCapabilityUnavailable } from '../inference/hosted-capability-error.js';

const EMBEDDING_DIMENSIONS = 1536;

/**
 * Refuses without resolving a model, credential or provider.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  void text;
  throw kaanaCapabilityUnavailable('embedding');
}

export { EMBEDDING_DIMENSIONS };
