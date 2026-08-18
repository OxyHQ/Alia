import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `POST /skills` and `PATCH /skills/:skillId` accept off the request body.
 *
 * `req.body` is `any`, so a value copied out of it satisfies whatever parameter
 * type `tsc` is asked to check it against. Mongoose used to catch the difference
 * at the schema — a number assigned to a `String` path was cast, an object to a
 * `[String]` path was rejected — and a `text`/`text[]` column catches none of
 * it. These cases are that protection, expressed where it now lives.
 *
 * The repository is mocked because the question here is what reaches it. What
 * the statements then DO is `skillRepository.pgdb.test.ts`'s, against a real
 * server.
 */

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../db/agents/skillRepository.js', () => ({
  createSkill: vi.fn(),
  deleteOwnedSkill: vi.fn(),
  findPublicSkill: vi.fn(),
  findSkillPrompt: vi.fn(),
  listOwnedSkills: vi.fn(),
  listSkillCatalogue: vi.fn(),
  skillIdExists: vi.fn(),
  updateOwnedSkill: vi.fn(),
}));

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  optionalAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  oxyClient: { getUserById: vi.fn() },
}));

vi.mock('../../lib/chat-core.js', () => ({
  resolveModel: vi.fn(),
  getAIModel: vi.fn(),
  getDefaultAliaModel: vi.fn(() => 'alia-v1'),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { skills: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import {
  createSkill,
  listSkillCatalogue,
  skillIdExists,
  updateOwnedSkill,
} from '../../db/agents/skillRepository.js';
import router from '../skills.js';

type Handler = (req: Record<string, unknown>, res: MockResponse) => Promise<unknown>;

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: Handler }[];
  };
}

/**
 * The LAST handler on a route's stack, not the first.
 *
 * `POST /skills` is registered as `(authenticateToken, handler)`, so taking
 * `stack[0]` would run the auth middleware and never reach the body handling
 * these cases are about.
 */
function handlerFor(method: 'get' | 'post' | 'patch' | 'delete', path: string): Handler {
  const layers = (router as unknown as { stack: RouteLayer[] }).stack;
  const layer = layers.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`no handler for ${method.toUpperCase()} ${path}`);
  const last = layer.route.stack[layer.route.stack.length - 1];
  return last.handle;
}

interface MockResponse {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
}

function makeRes(): MockResponse {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

const USER = { id: 'oxy-user-1', username: 'nate' };

function postBody(body: Record<string, unknown>): Record<string, unknown> {
  return { user: USER, body };
}

const VALID = {
  title: 'My Skill',
  tagline: 'a tagline',
  description: 'a description',
  systemPrompt: 'do the thing',
  icon: '🎯',
  color: '#6366f1',
  category: 'community',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(skillIdExists).mockResolvedValue(false);
  vi.mocked(createSkill).mockResolvedValue({ _id: 'sk1' } as never);
  vi.mocked(updateOwnedSkill).mockResolvedValue({ _id: 'sk1' } as never);
  vi.mocked(listSkillCatalogue).mockResolvedValue([]);
});

describe('POST /skills', () => {
  it('refuses a category outside the closed set, with 400 rather than a CHECK violation', async () => {
    const res = makeRes();
    await handlerFor('post', '/')(postBody({ ...VALID, category: 'awesome' }), res);

    expect(res.statusCode).toBe(400);
    expect(vi.mocked(createSkill)).not.toHaveBeenCalled();

    // The control: the same body with a real category gets through, so the 400
    // above is about `category` and not about the fixture being malformed.
    const ok = makeRes();
    await handlerFor('post', '/')(postBody(VALID), ok);
    expect(ok.statusCode).toBe(201);
    expect(vi.mocked(createSkill).mock.calls[0]?.[1]).toMatchObject({ category: 'community' });
  });

  it('drops a non-string where a string is required, rather than casting it', async () => {
    const res = makeRes();
    await handlerFor('post', '/')(postBody({ ...VALID, title: 12345 }), res);
    // `title` is one of the required fields, so a dropped value is a 400 rather
    // than a row with the string "12345" in it.
    expect(res.statusCode).toBe(400);
    expect(vi.mocked(createSkill)).not.toHaveBeenCalled();
  });

  it('coerces a malformed array field to empty instead of sending it to text[]', async () => {
    const res = makeRes();
    await handlerFor('post', '/')(
      postBody({ ...VALID, triggers: 'rm -rf /', goodAt: [1, 'kept', null] }),
      res,
    );

    expect(res.statusCode).toBe(201);
    const input = vi.mocked(createSkill).mock.calls[0]?.[1];
    expect(input?.triggers).toEqual([]);
    // A non-string ELEMENT is dropped individually; one bad entry does not
    // discard the rest.
    expect(input?.goodAt).toEqual(['kept']);
  });

  it('caps an array at ten, matching what the generator route already emits', async () => {
    const res = makeRes();
    const fifteen = Array.from({ length: 15 }, (_, i) => `t${i}`);
    await handlerFor('post', '/')(postBody({ ...VALID, triggers: fifteen }), res);

    expect(vi.mocked(createSkill).mock.calls[0]?.[1].triggers).toEqual(fifteen.slice(0, 10));
  });

  it('takes the owner from the SESSION, never from the body', async () => {
    const res = makeRes();
    await handlerFor('post', '/')(
      postBody({ ...VALID, oxyUserId: 'somebody-else', isBuiltIn: true, isPublished: true }),
      res,
    );

    const input = vi.mocked(createSkill).mock.calls[0]?.[1];
    expect(input?.oxyUserId).toBe(USER.id);
    // `isBuiltIn` and `isPublished` are not on the input type at all — the
    // repository writes both as literals — so a body that names them changes
    // nothing. Asserted because "mass assignment" is exactly what a spread of
    // `req.body` would have allowed here.
    expect(input).not.toHaveProperty('isBuiltIn');
    expect(input).not.toHaveProperty('isPublished');
  });

  it('suffixes the slug when the derived one is taken', async () => {
    vi.mocked(skillIdExists).mockResolvedValue(true);
    const res = makeRes();
    await handlerFor('post', '/')(postBody({ ...VALID, title: 'My Skill' }), res);

    const slug = vi.mocked(createSkill).mock.calls[0]?.[1].skillId;
    expect(slug).toMatch(/^my-skill-[0-9a-z]{4}$/);
  });
});

describe('PATCH /skills/:skillId', () => {
  const patchReq = (body: Record<string, unknown>): Record<string, unknown> => ({
    user: USER,
    params: { skillId: 'my-skill' },
    body,
  });

  it('sends only the keys the body names, so an omitted column is not nulled', async () => {
    const res = makeRes();
    await handlerFor('patch', '/:skillId')(patchReq({ title: 'New title' }), res);

    expect(vi.mocked(updateOwnedSkill).mock.calls[0]?.[3]).toEqual({ title: 'New title' });
  });

  it('ignores a key outside the whitelist, including the owner and the built-in flag', async () => {
    const res = makeRes();
    await handlerFor('patch', '/:skillId')(
      patchReq({ title: 'New', oxyUserId: 'somebody-else', isBuiltIn: false, skillId: 'stolen' }),
      res,
    );

    expect(vi.mocked(updateOwnedSkill).mock.calls[0]?.[3]).toEqual({ title: 'New' });
  });

  it('refuses an invalid category with 400 and issues no statement', async () => {
    const res = makeRes();
    await handlerFor('patch', '/:skillId')(patchReq({ category: 'awesome' }), res);

    expect(res.statusCode).toBe(400);
    expect(vi.mocked(updateOwnedSkill)).not.toHaveBeenCalled();
  });

  it('accepts isPublished only as a boolean', async () => {
    const res = makeRes();
    await handlerFor('patch', '/:skillId')(patchReq({ isPublished: 'yes' }), res);
    expect(vi.mocked(updateOwnedSkill).mock.calls[0]?.[3]).toEqual({});

    const ok = makeRes();
    await handlerFor('patch', '/:skillId')(patchReq({ isPublished: true }), ok);
    expect(vi.mocked(updateOwnedSkill).mock.calls[1]?.[3]).toEqual({ isPublished: true });
  });

  it('answers 404 when the repository refuses the write', async () => {
    // Not-yours, built-in and does-not-exist are ONE 404 — the source could not
    // tell them apart either, and splitting them would be a way to probe which
    // slugs exist.
    vi.mocked(updateOwnedSkill).mockResolvedValue(undefined);
    const res = makeRes();
    await handlerFor('patch', '/:skillId')(patchReq({ title: 'New' }), res);
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /skills', () => {
  it('passes a language and a category filter through, and drops category=all', async () => {
    const res = makeRes();
    await handlerFor('get', '/')({ query: { language: 'es-ES', category: 'all' } }, res);
    expect(vi.mocked(listSkillCatalogue).mock.calls[0]?.[1]).toEqual({ language: 'es-ES' });

    const res2 = makeRes();
    await handlerFor('get', '/')({ query: { category: 'featured' } }, res2);
    expect(vi.mocked(listSkillCatalogue).mock.calls[1]?.[1]).toEqual({ category: 'featured' });

    // A repeated array parameter (`?language=a&language=b`) arrives as an array
    // and must not reach the query as one.
    const res3 = makeRes();
    await handlerFor('get', '/')({ query: { language: ['a', 'b'] } }, res3);
    expect(vi.mocked(listSkillCatalogue).mock.calls[2]?.[1]).toEqual({});
  });
});
