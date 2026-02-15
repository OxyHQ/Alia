/**
 * Memory Embeddings
 * Generates embeddings for user memories using OpenAI text-embedding-3-small.
 * Graceful degradation: if embedding fails, returns null (never throws).
 */

import { log } from '../logger.js';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

/**
 * Generate an embedding vector for the given text.
 * Uses the first available OpenAI key from the providers system.
 * Returns null on any failure (network, rate limit, etc.) - never throws.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    // Get an OpenAI key from providers
    const { getBestKeyForModel } = await import('../../internal/providers/lib/key-manager.js');
    const keyConfig = await getBestKeyForModel('openai', 'text-embedding-3-small', 1000);
    if (!keyConfig) return null;

    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${keyConfig.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text.slice(0, 8000), // Limit input length
        dimensions: EMBEDDING_DIMENSIONS,
      }),
    });

    if (!response.ok) {
      log.memory.error({ status: response.status }, 'OpenAI API error');
      return null;
    }

    const data = await response.json() as any;
    return data.data?.[0]?.embedding || null;
  } catch (error) {
    log.memory.error({ err: error }, 'Error generating embedding');
    return null;
  }
}

export { EMBEDDING_DIMENSIONS };
