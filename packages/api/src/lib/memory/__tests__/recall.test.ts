// packages/api/src/lib/memory/__tests__/recall.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../embedding-cache.js', () => ({
  getCachedOrGenerateEmbedding: vi.fn().mockResolvedValue(null),
}));

vi.mock('../vector-search.js', () => ({
  searchByVector: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../models/user-memory.js', () => ({
  UserMemory: { findOne: vi.fn() },
}));

import { recallRelevantMemories } from '../recall.js';
import { UserMemory } from '../../../models/user-memory.js';

const mockFindOne = UserMemory.findOne as unknown as ReturnType<typeof vi.fn>;

describe('recallRelevantMemories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all memories when under topK and recall is enabled', async () => {
    mockFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        memories: [
          { title: 'Food', summary: 'Loves strawberries', type: 'topic', createdAt: new Date(), updatedAt: new Date() },
        ],
        settings: { autoSaveEnabled: true, recallEnabled: true },
      }),
    });

    const result = await recallRelevantMemories('user-1', 'what do I like to eat?', 7);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ title: 'Food', summary: 'Loves strawberries' });
  });

  it('returns empty when recallEnabled is false', async () => {
    mockFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        memories: [
          { title: 'Food', summary: 'Loves strawberries', type: 'topic', createdAt: new Date(), updatedAt: new Date() },
        ],
        settings: { autoSaveEnabled: true, recallEnabled: false },
      }),
    });

    const result = await recallRelevantMemories('user-1', 'what do I like to eat?', 7);

    expect(result).toEqual([]);
  });

  it('returns empty when the user has no memories', async () => {
    mockFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

    const result = await recallRelevantMemories('user-1', 'anything', 7);

    expect(result).toEqual([]);
  });
});
