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

import { getOrCreateUserMemory } from '../../lib/memory/user-memory-service.js';
import { AddMemorySchema, MemorySettingsSchema } from '../../lib/validators/memory-validators.js';
import router from '../memory.js';

const mockGetOrCreate = getOrCreateUserMemory as unknown as ReturnType<typeof vi.fn>;

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
      memories: [] as any[],
      settings: { autoSaveEnabled: true, recallEnabled: true },
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockGetOrCreate.mockResolvedValue(doc);

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
      memories: [] as any[],
      settings: { autoSaveEnabled: true, recallEnabled: true },
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockGetOrCreate.mockResolvedValue(doc);

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
