import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../memory/user-memory-service.js', () => ({
  getOrCreateUserMemory: vi.fn(),
}));

vi.mock('../../../models/subscription.js', () => ({
  Subscription: { findOne: vi.fn() },
}));

vi.mock('../../logger.js', () => ({
  log: { tools: { error: vi.fn() } },
}));

import { saveUserMemoryTool } from '../user-memory.js';
import { getOrCreateUserMemory } from '../../memory/user-memory-service.js';

const mockGetOrCreate = getOrCreateUserMemory as unknown as ReturnType<typeof vi.fn>;

function makeMemoryDoc(overrides: Partial<{ memories: any[]; settings: any }> = {}) {
  const doc = {
    memories: overrides.memories ?? [],
    settings: overrides.settings ?? { autoSaveEnabled: true, recallEnabled: true },
    save: vi.fn().mockResolvedValue(undefined),
  };
  return doc;
}

describe('saveUserMemoryTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves a new memory with title/summary/type', async () => {
    const doc = makeMemoryDoc();
    mockGetOrCreate.mockResolvedValue(doc);

    const toolInstance = saveUserMemoryTool('user-1');
    const result: any = await toolInstance.execute!(
      { title: 'Food', summary: 'Loves strawberries', type: 'topic' },
      { toolCallId: 't1', messages: [] }
    );

    expect(result.success).toBe(true);
    expect(doc.memories).toHaveLength(1);
    expect(doc.memories[0]).toMatchObject({ title: 'Food', summary: 'Loves strawberries', type: 'topic' });
    expect(doc.save).toHaveBeenCalled();
  });

  it('refuses to save when autoSaveEnabled is false', async () => {
    const doc = makeMemoryDoc({ settings: { autoSaveEnabled: false, recallEnabled: true } });
    mockGetOrCreate.mockResolvedValue(doc);

    const toolInstance = saveUserMemoryTool('user-1');
    const result: any = await toolInstance.execute!(
      { title: 'Food', summary: 'Loves strawberries', type: 'topic' },
      { toolCallId: 't2', messages: [] }
    );

    expect(result.success).toBe(false);
    expect(result.disabled).toBe(true);
    expect(doc.memories).toHaveLength(0);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('saves even when autoSaveEnabled is false, if bypassAutoSaveGate is set', async () => {
    const doc = makeMemoryDoc({ settings: { autoSaveEnabled: false, recallEnabled: true } });
    mockGetOrCreate.mockResolvedValue(doc);

    const toolInstance = saveUserMemoryTool('user-1', { bypassAutoSaveGate: true });
    const result: any = await toolInstance.execute!(
      { title: 'Food', summary: 'Loves strawberries', type: 'topic' },
      { toolCallId: 't4', messages: [] }
    );

    expect(result.success).toBe(true);
    expect(doc.memories).toHaveLength(1);
    expect(doc.save).toHaveBeenCalled();
  });

  it('updates an existing memory matched by case-insensitive title', async () => {
    const doc = makeMemoryDoc({
      memories: [{ title: 'Food', summary: 'old', type: 'topic', createdAt: new Date(), updatedAt: new Date() }],
    });
    mockGetOrCreate.mockResolvedValue(doc);

    const toolInstance = saveUserMemoryTool('user-1');
    const result: any = await toolInstance.execute!(
      { title: 'food', summary: 'Loves strawberries now', type: 'topic' },
      { toolCallId: 't3', messages: [] }
    );

    expect(result.success).toBe(true);
    expect(doc.memories).toHaveLength(1);
    expect(doc.memories[0].summary).toBe('Loves strawberries now');
  });
});
