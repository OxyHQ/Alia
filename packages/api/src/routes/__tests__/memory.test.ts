// packages/api/src/routes/__tests__/memory.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The repository replaces the model. `getDb()` is mocked too because the route
 * module calls it for a handle — otherwise every case fails with "Postgres is
 * not connected" before reaching the assertion it is about.
 *
 * `vi.importActual` is gone with the model: the constants this file's subject
 * uses (`getMemoryLimit`) now live in `domain/user-memory.ts`, which is not
 * mocked and needs no spreading.
 */
vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../db/memory/userMemoryRepository.js', () => ({
  addEntries: vi.fn(),
  countEntries: vi.fn(),
  deleteEntryById: vi.fn(),
  findEntryByTitle: vi.fn(),
  findUserMemory: vi.fn(),
  mergeContext: vi.fn(),
  mergePreferences: vi.fn(),
  normalizeMemoryTitle: (t: string) => t.trim().toLowerCase(),
  replaceContext: vi.fn(),
  replaceEntries: vi.fn(),
  replacePreferences: vi.fn(),
  saveEntryByTitle: vi.fn(),
  updateEntryById: vi.fn(),
  updateSettings: vi.fn(),
}));

// The subscription lookup moved to a Postgres repository; these suites care
// only that the memory limit falls back when there is no active subscription,
// so the repository is stubbed rather than the model. `db/index.js` is already
// mocked above for the memory repository, and the two share it.
vi.mock('../../db/billing/subscriptionRepository.js', () => ({
  findActiveSubscription: vi.fn().mockResolvedValue(null),
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

import { getOrCreateUserMemory } from '../../lib/memory/user-memory-service.js';
import {
  findEntryByTitle,
  findUserMemory,
  saveEntryByTitle,
  updateSettings,
} from '../../db/memory/userMemoryRepository.js';
import { AddMemorySchema, MemorySettingsSchema } from '../../lib/validators/memory-validators.js';
import router from '../memory.js';

const mockGetOrCreate = getOrCreateUserMemory as unknown as ReturnType<typeof vi.fn>;

/**
 * Point the mocked repository at one in-memory profile.
 *
 * The two handler cases below assert what the store ends up holding — that
 * `/add` inserts, that `/settings` changes ONE toggle and leaves the other —
 * and bare spies would reduce both to "the handler called something", which is
 * true of a handler that writes the wrong thing. `doc.save` counts writes, the
 * question the Mongoose `save()` it replaces was asked.
 */
interface FakeEntry { _id: string; title: string; summary: string; type: string }
interface FakeProfile {
  _id: string;
  memories: FakeEntry[];
  settings: { autoSaveEnabled: boolean; recallEnabled: boolean };
  save: ReturnType<typeof vi.fn<() => void>>;
}

function useProfile(doc: FakeProfile) {
  mockGetOrCreate.mockResolvedValue(doc);
  const fold = (t: string) => t.trim().toLowerCase();

  vi.mocked(findUserMemory).mockResolvedValue(doc as unknown as Awaited<ReturnType<typeof findUserMemory>>);
  vi.mocked(findEntryByTitle).mockImplementation(async (_db, _id, title) =>
    doc.memories.find((m) => fold(m.title) === fold(title)) as unknown as Awaited<ReturnType<typeof findEntryByTitle>>);
  vi.mocked(saveEntryByTitle).mockImplementation(async (_db, _id, incoming) => {
    doc.save();
    const i = doc.memories.findIndex((m) => fold(m.title) === fold(incoming.title));
    if (i !== -1) {
      doc.memories[i] = { ...doc.memories[i], summary: incoming.summary, type: incoming.type };
      return doc.memories[i] as unknown as Awaited<ReturnType<typeof saveEntryByTitle>>;
    }
    const created = { _id: `entry-${doc.memories.length + 1}`, ...incoming };
    doc.memories.push(created);
    return created as unknown as Awaited<ReturnType<typeof saveEntryByTitle>>;
  });
  vi.mocked(updateSettings).mockImplementation(async (_db, _id, patch) => {
    doc.save();
    if (patch.autoSaveEnabled !== undefined) doc.settings.autoSaveEnabled = patch.autoSaveEnabled;
    if (patch.recallEnabled !== undefined) doc.settings.recallEnabled = patch.recallEnabled;
  });
}

function getRouteHandler(method: 'get' | 'post' | 'put' | 'delete', path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`No route handler found for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle as (req: any, res: any) => Promise<void>;
}

function makeMockRes() {
  const res: any = {};
  res.statusCode = 200;
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res; });
  return res;
}

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
      _id: 'profile-1',
      memories: [] as FakeEntry[],
      settings: { autoSaveEnabled: true, recallEnabled: true },
      save: vi.fn<() => void>(),
    };
    useProfile(doc);

    const handler = getRouteHandler('post', '/add');
    const req: any = { user: { id: 'user-1' }, body: { title: 'Food', summary: 'Loves strawberries', type: 'topic' } };
    const res = makeMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(doc.memories).toHaveLength(1);
    expect(doc.memories[0]).toMatchObject({ title: 'Food', summary: 'Loves strawberries', type: 'topic' });
    expect(doc.save).toHaveBeenCalled();
  });

  it('updates settings via the real PUT /settings handler', async () => {
    const doc = {
      _id: 'profile-1',
      memories: [] as FakeEntry[],
      settings: { autoSaveEnabled: true, recallEnabled: true },
      save: vi.fn<() => void>(),
    };
    useProfile(doc);

    const handler = getRouteHandler('put', '/settings');
    const req: any = { user: { id: 'user-1' }, body: { autoSaveEnabled: false } };
    const res = makeMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(doc.settings.autoSaveEnabled).toBe(false);
    expect(doc.settings.recallEnabled).toBe(true); // untouched — proves this was a partial update, not an overwrite
    expect(doc.save).toHaveBeenCalled();
    expect(res.body).toEqual(doc.settings);
  });
});

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, generateText: vi.fn() };
});

vi.mock('../../lib/chat-core.js', () => ({
  resolveModel: vi.fn().mockResolvedValue({ keyConfig: {}, provider: 'test', modelId: 'test' }),
  getAIModel: vi.fn().mockReturnValue({}),
  getDefaultAliaModel: vi.fn().mockReturnValue('alia-v1'),
}));

vi.mock('../../lib/tools/index.js', () => ({
  saveUserMemoryTool: vi.fn().mockReturnValue({ execute: vi.fn() }),
}));

import { generateText } from 'ai';
import { resolveModel } from '../../lib/chat-core.js';

describe('POST /memory/import/from-text', () => {
  it('extracts and returns saved memories via the real route handler', async () => {
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      toolResults: [
        { toolName: 'saveUserMemory', input: { title: 'Food', summary: 'Loves strawberries', type: 'topic' }, output: { success: true } },
        { toolName: 'saveUserMemory', input: { title: 'Bad', summary: 'x', type: 'topic' }, output: { success: false } },
      ],
    });

    const handler = getRouteHandler('post', '/import/from-text');
    const req: any = { user: { id: 'user-1' }, body: { text: 'The user loves strawberries and dislikes cilantro.' } };
    const res = makeMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ saved: [{ title: 'Food', summary: 'Loves strawberries', type: 'topic' }] });
  });

  it('rejects text over 50,000 characters without calling generateText', async () => {
    const mockGenerateText = generateText as unknown as ReturnType<typeof vi.fn>;
    mockGenerateText.mockClear();

    const handler = getRouteHandler('post', '/import/from-text');
    const req: any = { user: { id: 'user-1' }, body: { text: 'x'.repeat(50_001) } };
    const res = makeMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('constructs saveUserMemoryTool with the initiator asserted server-side', async () => {
    const { saveUserMemoryTool } = await import('../../lib/tools/index.js');
    const mockSaveUserMemoryTool = saveUserMemoryTool as unknown as ReturnType<typeof vi.fn>;
    mockSaveUserMemoryTool.mockClear();

    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ toolResults: [] });

    const handler = getRouteHandler('post', '/import/from-text');
    const req: any = { user: { id: 'user-1' }, body: { text: 'some memory text' } };
    const res = makeMockRes();

    await handler(req, res);

    expect(mockSaveUserMemoryTool).toHaveBeenCalledWith('user-1', { initiatedBy: 'user' });
  });

  it('retries with a different provider when the first one fails, and succeeds', async () => {
    const mockResolveModel = resolveModel as unknown as ReturnType<typeof vi.fn>;
    const mockGenerateText = generateText as unknown as ReturnType<typeof vi.fn>;
    mockResolveModel.mockClear();
    mockGenerateText.mockClear();

    mockResolveModel
      .mockResolvedValueOnce({ provider: 'google', modelId: 'gemini-2.5-flash', keyConfig: { keyId: 'key-1' } })
      .mockResolvedValueOnce({ provider: 'openrouter', modelId: 'some-model', keyConfig: { keyId: 'key-2' } });

    mockGenerateText
      .mockRejectedValueOnce(Object.assign(new Error('quota exceeded'), { statusCode: 429 }))
      .mockResolvedValueOnce({
        toolResults: [
          { toolName: 'saveUserMemory', input: { title: 'Food', summary: 'Loves strawberries', type: 'topic' }, output: { success: true } },
        ],
      });

    const handler = getRouteHandler('post', '/import/from-text');
    const req: any = { user: { id: 'user-1' }, body: { text: 'The user loves strawberries.' } };
    const res = makeMockRes();

    await handler(req, res);

    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ saved: [{ title: 'Food', summary: 'Loves strawberries', type: 'topic' }] });
  });
});
