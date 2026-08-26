import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the skill routes accept, and what they refuse.
 *
 * The repository and the store are mocked, because the question here is what
 * REACHES them: which fields a patch may carry, which refusals produce a 400
 * rather than a constraint violation deeper down, and whether a write scoped to
 * an owner stays scoped. What the statements then do is
 * `skillRepository.pgdb.test.ts`'s job, against a real server.
 *
 * The one thing deliberately NOT mocked is the spec parser: a route that
 * accepted a malformed `SKILL.md` and let the database refuse it would be a 500
 * where a 400 belongs, and mocking the parser would hide exactly that.
 */

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../db/agents/skillRepository.js', () => ({
  createSkill: vi.fn(),
  deleteOwnedSkill: vi.fn(),
  findLatestVersion: vi.fn(),
  findSkillById: vi.fn(),
  findSkillByName: vi.fn(),
  findSkillFileByPath: vi.fn(),
  findSkillInNamespace: vi.fn(),
  installSkill: vi.fn(),
  listInstalledSkills: vi.fn(),
  listOwnedSkills: vi.fn(),
  listSkillCatalogue: vi.fn(),
  listSkillVersions: vi.fn(),
  listVersionFiles: vi.fn(),
  uninstallSkill: vi.fn(),
  updateInstall: vi.fn(),
  updateOwnedSkill: vi.fn(),
}));

vi.mock('../../lib/skills/store.js', () => ({ storeSkillBundle: vi.fn() }));
vi.mock('../../lib/skills/github.js', () => ({
  importSkillsFromGitHub: vi.fn(),
  sourceUrl: vi.fn(() => 'https://github.com/o/r/tree/sha/skills/x'),
  SkillImportError: class SkillImportError extends Error {},
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

vi.mock('../../lib/s3.js', () => ({ readS3Object: vi.fn() }));

vi.mock('../../lib/logger.js', () => ({
  log: { skills: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import {
  findSkillById,
  findSkillByName,
  findSkillInNamespace,
  installSkill,
  updateInstall,
  updateOwnedSkill,
} from '../../db/agents/skillRepository.js';
import { importSkillsFromGitHub } from '../../lib/skills/github.js';
import { storeSkillBundle } from '../../lib/skills/store.js';
import router from '../skills.js';

type Handler = (req: Record<string, unknown>, res: MockResponse) => Promise<unknown>;

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] };
}

/** The LAST handler on the stack: the first is the auth middleware. */
function handlerFor(method: 'get' | 'post' | 'patch' | 'delete', path: string): Handler {
  const layers = (router as unknown as { stack: RouteLayer[] }).stack;
  const layer = layers.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`no handler for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

interface MockResponse {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
  end: () => MockResponse;
  type: () => MockResponse;
  send: (body: unknown) => MockResponse;
}

function makeRes(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
    end() {
      return res;
    },
    type() {
      return res;
    },
    send(body) {
      res.body = body;
      return res;
    },
  };
  return res;
}

const USER = { id: 'oxy-user-1', username: 'nate' };

const SKILL = {
  _id: 'sk1',
  name: 'my-skill',
  displayName: 'My Skill',
  description: 'Does a thing. Use when a thing needs doing.',
  ownerOxyUserId: USER.id,
  visibility: 'private',
  source: 'authored',
};

const VALID = {
  name: 'my-skill',
  description: 'Does a thing. Use when a thing needs doing.',
  body: '# My Skill\n\nDo the thing.',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findSkillInNamespace).mockResolvedValue(null);
  vi.mocked(storeSkillBundle).mockResolvedValue({
    skill: SKILL as never,
    version: { _id: 'v1', version: 1 } as never,
    createdSkill: true,
    unchanged: false,
  });
  vi.mocked(installSkill).mockResolvedValue({ created: true });
});

describe('POST /skills', () => {
  it('turns fields into a SKILL.md, stores it, and puts it on the shelf', async () => {
    const res = makeRes();
    await handlerFor('post', '/')({ user: USER, body: VALID }, res);

    expect(res.statusCode).toBe(201);
    const bundle = vi.mocked(storeSkillBundle).mock.calls[0][1];
    expect(bundle.document.frontmatter.name).toBe('my-skill');
    expect(bundle.document.body).toBe('# My Skill\n\nDo the thing.');
    expect(vi.mocked(storeSkillBundle).mock.calls[0][2]).toMatchObject({
      source: 'authored',
      ownerOxyUserId: USER.id,
    });
    expect(vi.mocked(installSkill)).toHaveBeenCalledWith(expect.anything(), USER.id, 'sk1');
  });

  it('accepts a whole document, which is what the editor sends', async () => {
    const res = makeRes();
    await handlerFor('post', '/')(
      {
        user: USER,
        body: { document: '---\nname: my-skill\ndescription: Does a thing. Use when a thing needs doing.\n---\n\nBody.' },
      },
      res,
    );
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(storeSkillBundle).mock.calls[0][1].document.body).toBe('Body.');
  });

  it.each([
    ['a name the spec forbids', { ...VALID, name: 'My_Skill' }],
    ['a reserved word in the name', { ...VALID, name: 'claude-helper' }],
    ['a description over 1024 characters', { ...VALID, description: 'x'.repeat(1025) }],
    ['neither a document nor a name', { body: 'orphan' }],
  ])('refuses %s with a 400 rather than a database error', async (_label, body) => {
    const res = makeRes();
    await handlerFor('post', '/')({ user: USER, body }, res);

    expect(res.statusCode).toBe(400);
    expect(vi.mocked(storeSkillBundle)).not.toHaveBeenCalled();
  });

  it('refuses a name this account already uses, with 409', async () => {
    vi.mocked(findSkillInNamespace).mockResolvedValue(SKILL as never);
    const res = makeRes();
    await handlerFor('post', '/')({ user: USER, body: VALID }, res);

    expect(res.statusCode).toBe(409);
    expect(vi.mocked(storeSkillBundle)).not.toHaveBeenCalled();
  });
});

describe('POST /skills/import', () => {
  const IMPORT = {
    source: { owner: 'anthropics', repo: 'skills' },
    commit: 'a'.repeat(40),
    rejected: [],
    skills: [
      {
        directory: 'skills/pdf',
        bundle: { document: { frontmatter: { name: 'pdf' } }, warnings: [] },
      },
    ],
  };

  it('stores every imported skill against the resolved commit, and installs it', async () => {
    vi.mocked(importSkillsFromGitHub).mockResolvedValue(IMPORT as never);
    const res = makeRes();
    await handlerFor('post', '/import')({ user: USER, body: { source: 'anthropics/skills' } }, res);

    expect(res.statusCode).toBe(201);
    expect(vi.mocked(storeSkillBundle).mock.calls[0][2]).toMatchObject({
      source: 'github',
      ownerOxyUserId: USER.id,
      sourceRepo: 'anthropics/skills',
      sourcePath: 'skills/pdf',
      sourceCommit: IMPORT.commit,
      publisher: 'anthropics',
    });
    expect(vi.mocked(installSkill)).toHaveBeenCalled();
  });

  it('imports only the named skill when a repository holds several', async () => {
    vi.mocked(importSkillsFromGitHub).mockResolvedValue({
      ...IMPORT,
      skills: [
        ...IMPORT.skills,
        { directory: 'skills/xlsx', bundle: { document: { frontmatter: { name: 'xlsx' } }, warnings: [] } },
      ],
    } as never);

    const res = makeRes();
    await handlerFor('post', '/import')({ user: USER, body: { source: 'anthropics/skills', name: 'xlsx' } }, res);

    expect(res.statusCode).toBe(201);
    expect(vi.mocked(storeSkillBundle)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(storeSkillBundle).mock.calls[0][2]).toMatchObject({ sourcePath: 'skills/xlsx' });
  });

  it('answers 404 when the named skill is not in that repository', async () => {
    vi.mocked(importSkillsFromGitHub).mockResolvedValue(IMPORT as never);
    const res = makeRes();
    await handlerFor('post', '/import')({ user: USER, body: { source: 'anthropics/skills', name: 'missing' } }, res);

    expect(res.statusCode).toBe(404);
    expect(vi.mocked(storeSkillBundle)).not.toHaveBeenCalled();
  });
});

describe('POST /skills/upload', () => {
  /**
   * Multer runs for real here — the handler reads `req.files`, and a double that
   * handed it a shape multer never produces would test nothing about uploads.
   */
  async function upload(files: { name: string; content: string; mimetype?: string }[]) {
    const handler = handlerFor('post', '/upload');
    const res = makeRes();
    await handler(
      {
        user: USER,
        files: files.map((file) => ({
          originalname: file.name,
          mimetype: file.mimetype ?? 'text/markdown',
          buffer: Buffer.from(file.content),
        })),
        body: {},
      },
      res,
    );
    return res;
  }

  const DOCUMENT = '---\nname: my-skill\ndescription: Does a thing. Use when a thing needs doing.\n---\n\nBody.';

  it('accepts path-qualified files, the shape the Skills API takes', async () => {
    const res = await upload([
      { name: 'my-skill/SKILL.md', content: DOCUMENT },
      { name: 'my-skill/references/API.md', content: '# API' },
    ]);

    expect(res.statusCode).toBe(201);
    const bundle = vi.mocked(storeSkillBundle).mock.calls[0][1];
    expect(bundle.document.frontmatter.name).toBe('my-skill');
    expect(bundle.files.map((file) => file.path)).toEqual(['references/API.md']);
  });

  it('accepts a flat upload with SKILL.md at the root', async () => {
    const res = await upload([{ name: 'SKILL.md', content: DOCUMENT }]);
    expect(res.statusCode).toBe(201);
  });

  it('refuses an upload with no SKILL.md', async () => {
    const res = await upload([{ name: 'README.md', content: '# hi' }]);
    expect(res.statusCode).toBe(400);
    expect(vi.mocked(storeSkillBundle)).not.toHaveBeenCalled();
  });

  it('refuses an upload holding two skills', async () => {
    const res = await upload([
      { name: 'a/SKILL.md', content: DOCUMENT },
      { name: 'b/SKILL.md', content: DOCUMENT },
    ]);
    expect(res.statusCode).toBe(400);
  });

  it('refuses an empty upload', async () => {
    const res = await upload([]);
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /skills/:id', () => {
  beforeEach(() => {
    vi.mocked(updateOwnedSkill).mockResolvedValue(SKILL as never);
  });

  it('carries presentation and publication through', async () => {
    const res = makeRes();
    await handlerFor('patch', '/:id')(
      { user: USER, params: { id: 'sk1' }, body: { displayName: 'Renamed', visibility: 'public', tags: ['writing'] } },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(updateOwnedSkill).mock.calls[0][3]).toEqual({
      displayName: 'Renamed',
      visibility: 'public',
      tags: ['writing'],
    });
  });

  it.each([
    ['name', { name: 'renamed-skill' }],
    ['description', { description: 'Something else entirely.' }],
    ['owner', { ownerOxyUserId: 'somebody-else' }],
    ['installCount', { installCount: 9999 }],
  ])('drops %s, which a patch may not change', async (_label, body) => {
    const res = makeRes();
    await handlerFor('patch', '/:id')({ user: USER, params: { id: 'sk1' }, body }, res);

    // Zod strips what the schema does not name, leaving an empty patch that
    // reaches the repository as one — where it is refused rather than applied.
    expect(vi.mocked(updateOwnedSkill).mock.calls[0][3]).toEqual({});
  });

  it('is scoped to the caller: the repository decides, and a miss is a 404', async () => {
    vi.mocked(updateOwnedSkill).mockResolvedValue(undefined);
    const res = makeRes();
    await handlerFor('patch', '/:id')({ user: USER, params: { id: 'sk1' }, body: { displayName: 'x' } }, res);

    expect(res.statusCode).toBe(404);
    expect(vi.mocked(updateOwnedSkill).mock.calls[0][2]).toBe(USER.id);
  });
});

describe('POST /skills/:id/versions', () => {
  it('refuses a version that renames the skill', async () => {
    vi.mocked(findSkillById).mockResolvedValue(SKILL as never);
    const res = makeRes();
    await handlerFor('post', '/:id/versions')(
      { user: USER, params: { id: 'sk1' }, body: { ...VALID, name: 'different-name' } },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('name_immutable');
    expect(vi.mocked(storeSkillBundle)).not.toHaveBeenCalled();
  });

  it('refuses a version for somebody else’s skill as a 404', async () => {
    vi.mocked(findSkillById).mockResolvedValue({ ...SKILL, ownerOxyUserId: 'someone-else' } as never);
    const res = makeRes();
    await handlerFor('post', '/:id/versions')({ user: USER, params: { id: 'sk1' }, body: VALID }, res);

    expect(res.statusCode).toBe(404);
  });
});

describe('the shelf', () => {
  it('installs a public skill somebody else owns', async () => {
    vi.mocked(findSkillById).mockResolvedValue({ ...SKILL, ownerOxyUserId: 'other', visibility: 'public' } as never);
    const res = makeRes();
    await handlerFor('post', '/:id/install')({ user: USER, params: { id: 'sk1' }, body: {} }, res);

    expect(res.statusCode).toBe(201);
    expect(vi.mocked(installSkill)).toHaveBeenCalledWith(expect.anything(), USER.id, 'sk1');
  });

  it('refuses to install a private skill belonging to somebody else', async () => {
    vi.mocked(findSkillById).mockResolvedValue({ ...SKILL, ownerOxyUserId: 'other', visibility: 'private' } as never);
    vi.mocked(findSkillByName).mockResolvedValue(null);
    const res = makeRes();
    await handlerFor('post', '/:id/install')({ user: USER, params: { id: 'sk1' }, body: {} }, res);

    expect(res.statusCode).toBe(404);
    expect(vi.mocked(installSkill)).not.toHaveBeenCalled();
  });

  it('answers a second install 200 rather than an error', async () => {
    vi.mocked(findSkillById).mockResolvedValue(SKILL as never);
    vi.mocked(installSkill).mockResolvedValue({ created: false });
    const res = makeRes();
    await handlerFor('post', '/:id/install')({ user: USER, params: { id: 'sk1' }, body: {} }, res);

    expect(res.statusCode).toBe(200);
  });

  it('patches the install, including un-pinning with an explicit null', async () => {
    vi.mocked(updateInstall).mockResolvedValue(true);
    const res = makeRes();
    await handlerFor('patch', '/:id/install')(
      { user: USER, params: { id: 'sk1' }, body: { enabled: false, pinnedVersion: null } },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(updateInstall).mock.calls[0][3]).toEqual({ enabled: false, pinnedVersion: null });
  });

  it('answers 404 when patching an install that does not exist', async () => {
    vi.mocked(updateInstall).mockResolvedValue(false);
    const res = makeRes();
    await handlerFor('patch', '/:id/install')({ user: USER, params: { id: 'sk1' }, body: { enabled: true } }, res);

    expect(res.statusCode).toBe(404);
  });
});

describe('GET /skills/:idOrName', () => {
  it('hides a private skill from anybody but its owner', async () => {
    vi.mocked(findSkillById).mockResolvedValue({ ...SKILL, ownerOxyUserId: 'other' } as never);
    vi.mocked(findSkillByName).mockResolvedValue(null);

    const res = makeRes();
    await handlerFor('get', '/:idOrName')({ user: USER, params: { idOrName: 'sk1' } }, res);
    expect(res.statusCode).toBe(404);
  });
});
