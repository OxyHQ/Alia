// packages/api/src/routes/__tests__/memory.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Alia's memory of the person is Nilo's, so `/memory` serves only her settings: the profile,
 * the preferences she answers by, the "Use in AI responses" toggle and the agents that remember
 * the person. The repository replaces the model; `getDb()` is mocked because the route calls it
 * for a handle.
 */
vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../db/memory/userMemoryRepository.js', () => ({
  findUserMemory: vi.fn(),
  replacePreferences: vi.fn(),
  updateSettings: vi.fn(),
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

import {
  findUserMemory,
  replacePreferences,
  updateSettings,
} from '../../db/memory/userMemoryRepository.js';
import { MemorySettingsSchema } from '../../lib/validators/memory-validators.js';
import { getOrCreateUserMemory } from '../../lib/memory/user-memory-service.js';
import router from '../memory.js';

const mockGetOrCreate = getOrCreateUserMemory as unknown as ReturnType<typeof vi.fn>;

function getRouteHandler(method: 'get' | 'post' | 'put' | 'delete', path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No route handler found for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle as (req: any, res: any) => Promise<void>;
}

function makeMockRes() {
  const res: any = {};
  res.statusCode = 200;
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

const profile = () => ({
  _id: 'profile-1',
  oxyUserId: 'user-1',
  settings: { autoSaveEnabled: true, recallEnabled: true },
  preferences: { language: 'es-ES' },
  writingStyle: null,
});

describe('memory routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrCreate.mockResolvedValue(profile());
    vi.mocked(findUserMemory).mockResolvedValue(
      profile() as unknown as Awaited<ReturnType<typeof findUserMemory>>,
    );
  });

  it('serves the profile on GET /', async () => {
    const res = makeMockRes();
    await getRouteHandler('get', '/')({ user: { id: 'user-1' } }, res);
    expect(res.body).toMatchObject({ settings: { recallEnabled: true } });
    expect(mockGetOrCreate).toHaveBeenCalledWith('user-1');
  });

  it('replaces only the named preferences: language, tone and response length', async () => {
    const res = makeMockRes();
    await getRouteHandler('put', '/preferences')(
      {
        user: { id: 'user-1' },
        body: {
          language: 'en-US',
          tone: 'casual',
          responseLength: 'short',
          interests: ['chess'],
          isAdmin: true,
        },
      },
      res,
    );
    expect(replacePreferences).toHaveBeenCalledWith({}, 'profile-1', {
      language: 'en-US',
      tone: 'casual',
      responseLength: 'short',
    });
  });

  it('changes one toggle and leaves the other', async () => {
    const res = makeMockRes();
    await getRouteHandler('put', '/settings')(
      { user: { id: 'user-1' }, body: { recallEnabled: false } },
      res,
    );
    expect(updateSettings).toHaveBeenCalledWith({}, 'profile-1', {
      autoSaveEnabled: undefined,
      recallEnabled: false,
    });
  });

  it('refuses malformed settings', async () => {
    const res = makeMockRes();
    await getRouteHandler('put', '/settings')(
      { user: { id: 'user-1' }, body: { recallEnabled: 'yes' } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(MemorySettingsSchema.safeParse({ recallEnabled: 'yes' }).success).toBe(false);
  });

  it('has no route that adds, searches, imports, exports or edits memories: they are Nilo’s', () => {
    const paths = (router as any).stack
      .filter((layer: any) => layer.route)
      .map(
        (layer: any) => `${Object.keys(layer.route.methods)[0]?.toUpperCase()} ${layer.route.path}`,
      )
      .sort();
    expect(paths).toEqual(['GET /', 'PUT /preferences', 'PUT /settings']);
  });
});
