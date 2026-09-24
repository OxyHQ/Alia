// packages/api/src/lib/memory/__tests__/recall.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../embedding-cache.js', () => ({
  getCachedOrGenerateEmbedding: vi.fn().mockResolvedValue(null),
}));

vi.mock('../vector-search.js', () => ({
  searchByVector: vi.fn().mockResolvedValue([]),
}));

/**
 * The repository is mocked where the MODEL used to be. `getDb()` is mocked
 * alongside it because `recall.ts` calls it to obtain the handle — without that
 * the module throws "Postgres is not connected" before reaching the stub, which
 * would fail every case here for a reason that has nothing to do with recall.
 */
vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../../db/memory/userMemoryRepository.js', () => ({
  findUserMemory: vi.fn(),
}));

import { recallRelevantMemories } from '../recall.js';
import { findUserMemory } from '../../../db/memory/userMemoryRepository.js';
import { getCachedOrGenerateEmbedding } from '../embedding-cache.js';

const mockFindOne = findUserMemory as unknown as ReturnType<typeof vi.fn>;

describe('recallRelevantMemories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all memories when under topK and recall is enabled', async () => {
    mockFindOne.mockResolvedValue({
        memories: [
          { title: 'Food', summary: 'Loves strawberries', type: 'topic', createdAt: new Date(), updatedAt: new Date() },
        ],
        settings: { autoSaveEnabled: true, recallEnabled: true },
      });

    const result = await recallRelevantMemories('user-1', 'what do I like to eat?', 7);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ title: 'Food', summary: 'Loves strawberries' });
  });

  it('returns empty when recallEnabled is false', async () => {
    mockFindOne.mockResolvedValue({
        memories: [
          { title: 'Food', summary: 'Loves strawberries', type: 'topic', createdAt: new Date(), updatedAt: new Date() },
        ],
        settings: { autoSaveEnabled: true, recallEnabled: false },
      });

    const result = await recallRelevantMemories('user-1', 'what do I like to eat?', 7);

    expect(result).toEqual([]);
  });

  it('returns empty when the user has no memories', async () => {
    mockFindOne.mockResolvedValue(undefined);

    const result = await recallRelevantMemories('user-1', 'anything', 7);

    expect(result).toEqual([]);
  });

  it('still recalls by keyword when embeddings are unavailable, past topK', async () => {
    // Embeddings fail closed (`embeddings.ts`). The throw used to escape recall,
    // so anyone with more than topK memories got nothing at all.
    vi.mocked(getCachedOrGenerateEmbedding).mockRejectedValueOnce(new Error('embedding unavailable'));
    const filler = Array.from({ length: 10 }, (_, i) => ({
      title: `Filler ${i}`, summary: 'Something unrelated', type: 'topic', createdAt: new Date(), updatedAt: new Date(),
    }));
    mockFindOne.mockResolvedValue({
      memories: [
        ...filler,
        { title: 'Food', summary: 'Loves strawberries', type: 'topic', createdAt: new Date(), updatedAt: new Date() },
      ],
      settings: { autoSaveEnabled: true, recallEnabled: true },
    });

    const result = await recallRelevantMemories('user-1', 'do you remember the strawberries?', 3);

    expect(result[0]).toMatchObject({ title: 'Food' });
  });

  it('weighs a term by how many memories mention it, so a rare term outranks a common one', async () => {
    const common = Array.from({ length: 9 }, (_, i) => ({
      title: `Work ${i}`, summary: 'meeting notes', type: 'topic', createdAt: new Date(), updatedAt: new Date(),
    }));
    mockFindOne.mockResolvedValue({
      memories: [
        ...common,
        { title: 'Pet', summary: 'meeting with the vet about the iguana', type: 'topic', createdAt: new Date(), updatedAt: new Date() },
      ],
      settings: { autoSaveEnabled: true, recallEnabled: true },
    });

    const result = await recallRelevantMemories('user-1', 'meeting iguana', 3);

    expect(result[0]).toMatchObject({ title: 'Pet' });
  });
});
