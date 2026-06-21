/**
 * Memory Embeddings
 * Generates embeddings for user memories using OpenAI text-embedding-3-small.
 * Graceful degradation: if embedding fails, returns null (never throws).
 */

import { callProviderAPI } from '../gateway-client.js';
import { log } from '../logger.js';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

/**
 * Generate an embedding vector for the given text.
 * Uses the internal provider system for key management and retries.
 * Returns null on any failure (network, rate limit, etc.) - never throws.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const data = await callProviderAPI<any>({
      provider: 'openai',
      modelId: EMBEDDING_MODEL,
      endpoint: '/v1/embeddings',
      body: {
        model: EMBEDDING_MODEL,
        input: text.slice(0, 8000),
        dimensions: EMBEDDING_DIMENSIONS,
      },
    });
    return data.data?.[0]?.embedding || null;
  } catch (error) {
    log.memory.error({ err: error }, 'Error generating embedding');
    return null;
  }
}

export { EMBEDDING_DIMENSIONS };
