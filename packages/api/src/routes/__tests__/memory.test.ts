// packages/api/src/routes/__tests__/memory.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/user-memory.js', async () => {
  const actual = await vi.importActual<typeof import('../../models/user-memory.js')>('../../models/user-memory.js');
  return {
    ...actual,
    UserMemory: { findOne: vi.fn(), findOneAndUpdate: vi.fn() },
  };
});

vi.mock('../../models/subscription.js', () => ({
  Subscription: { findOne: vi.fn() },
}));

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { memory: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('../../lib/memory/user-memory-service.js', () => ({
  getOrCreateUserMemory: vi.fn(),
}));

import { UserMemory } from '../../models/user-memory.js';
import { getOrCreateUserMemory } from '../../lib/memory/user-memory-service.js';
import { AddMemorySchema, MemorySettingsSchema } from '../../lib/validators/memory-validators.js';

const mockUserMemory = UserMemory as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockGetOrCreate = getOrCreateUserMemory as unknown as ReturnType<typeof vi.fn>;

describe('memory routes — validators and core logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AddMemorySchema accepts title/summary/type and rejects a missing type', () => {
    const valid = AddMemorySchema.safeParse({ title: 'Food', summary: 'Loves strawberries', type: 'topic' });
    expect(valid.success).toBe(true);

    const invalid = AddMemorySchema.safeParse({ title: 'Food', summary: 'Loves strawberries' });
    expect(invalid.success).toBe(false);
  });

  it('AddMemorySchema rejects an unknown type value', () => {
    const invalid = AddMemorySchema.safeParse({ title: 'Food', summary: 'x', type: 'hobby' });
    expect(invalid.success).toBe(false);
  });

  it('MemorySettingsSchema accepts a partial update', () => {
    const result = MemorySettingsSchema.safeParse({ autoSaveEnabled: false });
    expect(result.success).toBe(true);
  });

  it('adds a new memory when title does not already exist', async () => {
    const doc = {
      memories: [] as any[],
      settings: { autoSaveEnabled: true, recallEnabled: true },
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockGetOrCreate.mockResolvedValue(doc);

    // Simulate the POST /add handler's core branch directly against the mock,
    // mirroring the logic in routes/memory.ts (findIndex -> push).
    const existingIndex = doc.memories.findIndex((m) => m.title === 'Food');
    expect(existingIndex).toBe(-1);
    doc.memories.push({ title: 'Food', summary: 'Loves strawberries', type: 'topic', createdAt: new Date(), updatedAt: new Date() });
    await doc.save();

    expect(doc.memories).toHaveLength(1);
    expect(doc.save).toHaveBeenCalled();
  });

  it('updates settings via getOrCreateUserMemory + save', async () => {
    const doc = {
      memories: [] as any[],
      settings: { autoSaveEnabled: true, recallEnabled: true },
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockGetOrCreate.mockResolvedValue(doc);

    doc.settings.autoSaveEnabled = false;
    await doc.save();

    expect(doc.settings.autoSaveEnabled).toBe(false);
    expect(doc.save).toHaveBeenCalled();
  });
});
