import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolCallOptions } from '@ai-sdk/provider-utils';

vi.mock('../../memory/user-memory-service.js', () => ({
  getOrCreateUserMemory: vi.fn(),
}));

vi.mock('../../../models/subscription.js', () => ({
  Subscription: { findOne: vi.fn() },
}));

vi.mock('../../logger.js', () => ({
  log: { tools: { error: vi.fn() } },
}));

import { saveUserMemoryTool, updateUserMemoryTool } from '../user-memory.js';
import { getOrCreateUserMemory } from '../../memory/user-memory-service.js';
import type { MemoryType } from '../../../models/user-memory.js';

const mockGetOrCreate = vi.mocked(getOrCreateUserMemory);

interface MemoryEntry {
  title: string;
  summary: string;
  type: MemoryType;
  createdAt: Date;
  updatedAt: Date;
}

interface MemorySettings {
  autoSaveEnabled: boolean;
  recallEnabled: boolean;
}

interface MemoryDoc {
  memories: MemoryEntry[];
  settings: MemorySettings;
  save: ReturnType<typeof vi.fn>;
}

/** The shape both memory tools return; every field past `success` is optional. */
interface MemoryToolResult {
  success: boolean;
  message: string;
  disabled?: boolean;
  notFound?: boolean;
  conflict?: boolean;
  title?: string;
  summary?: string;
  type?: MemoryType;
}

function makeMemoryDoc(overrides: Partial<Pick<MemoryDoc, 'memories' | 'settings'>> = {}): MemoryDoc {
  return {
    memories: overrides.memories ?? [],
    settings: overrides.settings ?? { autoSaveEnabled: true, recallEnabled: true },
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function entry(title: string, summary = 'old', type: MemoryType = 'topic'): MemoryEntry {
  return { title, summary, type, createdAt: new Date(), updatedAt: new Date() };
}

/**
 * The document the tools mutate is a mongoose model at runtime; the mocked
 * stand-in only carries the fields they touch, so it goes in as the shape the
 * mock declares rather than the full model type.
 */
function useDoc(doc: MemoryDoc): void {
  mockGetOrCreate.mockResolvedValue(doc as unknown as Awaited<ReturnType<typeof getOrCreateUserMemory>>);
}

/** `Tool.execute` may resolve or return outright, so the return type stays open. */
interface Executable<TArgs> {
  execute?: (args: TArgs, options: ToolCallOptions) => unknown;
}

async function run<TArgs>(instance: Executable<TArgs>, args: TArgs, toolCallId: string): Promise<MemoryToolResult> {
  const { execute } = instance;
  if (!execute) throw new Error('tool is missing its executor');
  return (await execute(args, { toolCallId, messages: [] } as ToolCallOptions)) as MemoryToolResult;
}

describe('saveUserMemoryTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves a new memory with title/summary/type', async () => {
    const doc = makeMemoryDoc();
    useDoc(doc);

    const result = await run(
      saveUserMemoryTool('user-1'),
      { title: 'Food', summary: 'Loves strawberries', type: 'topic', initiatedBy: 'assistant' },
      't1'
    );

    expect(result.success).toBe(true);
    expect(doc.memories).toHaveLength(1);
    expect(doc.memories[0]).toMatchObject({ title: 'Food', summary: 'Loves strawberries', type: 'topic' });
    expect(doc.save).toHaveBeenCalled();
  });

  it('refuses an assistant-initiated save when autoSaveEnabled is false', async () => {
    const doc = makeMemoryDoc({ settings: { autoSaveEnabled: false, recallEnabled: true } });
    useDoc(doc);

    const result = await run(
      saveUserMemoryTool('user-1'),
      { title: 'Food', summary: 'Loves strawberries', type: 'topic', initiatedBy: 'assistant' },
      't2'
    );

    expect(result.success).toBe(false);
    expect(result.disabled).toBe(true);
    expect(doc.memories).toHaveLength(0);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('saves when autoSaveEnabled is false but the user asked for it', async () => {
    const doc = makeMemoryDoc({ settings: { autoSaveEnabled: false, recallEnabled: true } });
    useDoc(doc);

    const result = await run(
      saveUserMemoryTool('user-1'),
      { title: 'Food', summary: 'Loves strawberries', type: 'topic', initiatedBy: 'user' },
      't3'
    );

    expect(result.success).toBe(true);
    expect(doc.memories).toHaveLength(1);
    expect(doc.save).toHaveBeenCalled();
  });

  it('lets the caller assert the initiator, overriding the model argument', async () => {
    const doc = makeMemoryDoc({ settings: { autoSaveEnabled: false, recallEnabled: true } });
    useDoc(doc);

    const result = await run(
      saveUserMemoryTool('user-1', { initiatedBy: 'user' }),
      { title: 'Food', summary: 'Loves strawberries', type: 'topic', initiatedBy: 'assistant' },
      't4'
    );

    expect(result.success).toBe(true);
    expect(doc.memories).toHaveLength(1);
  });

  it('updates an existing memory matched by case-insensitive title', async () => {
    const doc = makeMemoryDoc({ memories: [entry('Food')] });
    useDoc(doc);

    const result = await run(
      saveUserMemoryTool('user-1'),
      { title: 'food', summary: 'Loves strawberries now', type: 'topic', initiatedBy: 'assistant' },
      't5'
    );

    expect(result.success).toBe(true);
    expect(doc.memories).toHaveLength(1);
    expect(doc.memories[0].summary).toBe('Loves strawberries now');
  });
});

describe('updateUserMemoryTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renames in place instead of leaving the old memory behind', async () => {
    const doc = makeMemoryDoc({ memories: [entry('Food', 'Loves strawberries')] });
    useDoc(doc);

    const result = await run(
      updateUserMemoryTool('user-1'),
      { currentTitle: 'Food', title: 'Favourite food' },
      'u1'
    );

    expect(result.success).toBe(true);
    expect(doc.memories).toHaveLength(1);
    expect(doc.memories[0].title).toBe('Favourite food');
    expect(doc.memories[0].summary).toBe('Loves strawberries');
    expect(doc.save).toHaveBeenCalled();
  });

  it('changes summary and type while keeping the title', async () => {
    const doc = makeMemoryDoc({ memories: [entry('Food')] });
    useDoc(doc);

    const result = await run(
      updateUserMemoryTool('user-1'),
      { currentTitle: 'food', summary: 'Allergic to nuts', type: 'profile' },
      'u2'
    );

    expect(result.success).toBe(true);
    expect(doc.memories[0]).toMatchObject({ title: 'Food', summary: 'Allergic to nuts', type: 'profile' });
  });

  it('refuses when no memory carries that title', async () => {
    const doc = makeMemoryDoc({ memories: [entry('Food')] });
    useDoc(doc);

    const result = await run(
      updateUserMemoryTool('user-1'),
      { currentTitle: 'Sport', summary: 'Runs daily' },
      'u3'
    );

    expect(result.success).toBe(false);
    expect(result.notFound).toBe(true);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('refuses a rename that collides with another memory', async () => {
    const doc = makeMemoryDoc({ memories: [entry('Food'), entry('Sport')] });
    useDoc(doc);

    const result = await run(
      updateUserMemoryTool('user-1'),
      { currentTitle: 'Food', title: 'sport' },
      'u4'
    );

    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
    expect(doc.memories[0].title).toBe('Food');
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('refuses a call that would change nothing', async () => {
    const doc = makeMemoryDoc({ memories: [entry('Food')] });
    useDoc(doc);

    const result = await run(updateUserMemoryTool('user-1'), { currentTitle: 'Food' }, 'u5');

    expect(result.success).toBe(false);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('is not gated by autoSaveEnabled', async () => {
    const doc = makeMemoryDoc({
      memories: [entry('Food')],
      settings: { autoSaveEnabled: false, recallEnabled: true },
    });
    useDoc(doc);

    const result = await run(
      updateUserMemoryTool('user-1'),
      { currentTitle: 'Food', summary: 'Loves ramen' },
      'u6'
    );

    expect(result.success).toBe(true);
    expect(doc.memories[0].summary).toBe('Loves ramen');
  });
});
