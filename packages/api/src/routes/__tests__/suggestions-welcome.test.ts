/**
 * `POST /suggestions/welcome` with `{ agentId?, clientContext? }`
 * (`docs/agent-embedding.md` §7): with an agent, that agent's starters, for an
 * agent the caller may use and nobody else; without one, Alia's pool, with what
 * the embedding app's context names put first.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  agent: null as Record<string, unknown> | null,
  reach: 'reachable' as string,
  reachCalls: [] as unknown[],
  pool: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../db/memory/userMemoryRepository.js', () => ({ findUserMemory: async () => null }));
vi.mock('../../db/notifications/suggestionRepository.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/notifications/suggestionRepository.js')>()),
  listWelcomePool: async () => state.pool.map((row) => ({ ...row })),
}));
vi.mock('../../db/agents/agentRepository.js', () => ({
  findAgentById: async () => state.agent,
}));
vi.mock('../../lib/agent-account.js', () => ({
  canReachAgent: async (_agent: unknown, caller: unknown) => {
    state.reachCalls.push(caller);
    return state.reach;
  },
}));
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (_req: unknown, _res: unknown, next: () => void) => next(),
  optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../lib/memory/user-memory-service.js', () => ({
  getUserLanguage: async () => 'es-ES',
}));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../lib/inference/kaana-text.js', () => ({ generateTextViaKaana: vi.fn() }));

import router from '../suggestions.js';

function welcomeHandler() {
  const layer = (
    router as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: unknown }>;
        };
      }>;
    }
  ).stack.find((l) => l.route?.path === '/welcome' && l.route.methods.post);
  if (!layer?.route) throw new Error('POST /welcome is not mounted');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: unknown, res: unknown) => Promise<void>;
}

async function welcome(body: Record<string, unknown>, user?: { id: string }) {
  const res = { statusCode: 200, body: undefined as unknown } as {
    statusCode: number;
    body: unknown;
    status: (code: number) => typeof res;
    json: (body: unknown) => typeof res;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  await welcomeHandler()({ body, ...(user ? { user, accessToken: 'TOKEN' } : {}) }, res);
  return res;
}

const suggestion = (id: string, tags: string[], category = 'general') => ({
  suggestionId: id,
  title: id,
  text: id,
  tags,
  category,
  priority: 0,
  interests: [],
  occupations: [],
});

beforeEach(() => {
  state.agent = {
    id: 'sindi',
    starters: [
      { title: 'Lease review', prompt: 'Can you review my lease?' },
      { title: 'Find housing', prompt: 'Find a {rooms}-room flat in {city}' },
    ],
  };
  state.reach = 'reachable';
  state.reachCalls.length = 0;
  state.pool = [];
});

describe('with an agent', () => {
  it("answers that agent's starters, shaped as suggestions", async () => {
    const res = await welcome({ agentId: 'sindi' }, { id: 'person-1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      suggestions: [
        {
          suggestionId: 'agent:sindi:0',
          title: 'Lease review',
          text: 'Can you review my lease?',
          type: 'welcome',
          isTemplate: false,
          language: 'es-ES',
        },
        {
          suggestionId: 'agent:sindi:1',
          isTemplate: true,
          templateVariables: ['rooms', 'city'],
        },
      ],
    });
    expect(state.reachCalls).toEqual([{ oxyUserId: 'person-1', accessToken: 'TOKEN' }]);
  });

  it('is 404 for an agent the caller may not use, and for one that does not exist', async () => {
    state.reach = 'out_of_reach';
    expect((await welcome({ agentId: 'private' }, { id: 'person-1' })).statusCode).toBe(404);
    state.reach = 'identity_unavailable';
    expect((await welcome({ agentId: 'private' }, { id: 'person-1' })).statusCode).toBe(404);
    state.agent = null;
    expect((await welcome({ agentId: 'nobody' }, { id: 'person-1' })).statusCode).toBe(404);
  });

  it('asks about an anonymous caller with no bearer at all', async () => {
    await welcome({ agentId: 'sindi' });
    expect(state.reachCalls).toEqual([{ oxyUserId: '', accessToken: undefined }]);
  });

  it('refuses an agentId or clientContext that is not a string', async () => {
    expect((await welcome({ agentId: 7 })).statusCode).toBe(400);
    expect((await welcome({ clientContext: { page: 'x' } })).statusCode).toBe(400);
  });
});

describe('without an agent', () => {
  it('puts first what the embedding app says the person is looking at', async () => {
    state.pool = [
      suggestion('poem', ['writing']),
      suggestion('rent', ['housing', 'rent']),
      suggestion('code', ['coding']),
      suggestion('move', [], 'housing'),
    ];
    const res = await welcome({
      count: 4,
      clientContext: 'Listing page: 2-room flat, rent 900 EUR',
    });
    const ids = (res.body as { suggestions: Array<{ suggestionId: string }> }).suggestions.map(
      (s) => s.suggestionId,
    );
    expect(ids[0]).toBe('rent');
    expect(ids).toHaveLength(4);
  });
});
