/**
 * `/spaces` (ADR 0028): the rules about who may do what. The repository is covered against a real
 * database (`db/__tests__/spaces.pgdb.test.ts`); here the repository is a double and what is asserted is
 * what the ROUTES decide: shape, standing over each agent before anything is written, and the answer for
 * a space that is not the caller's.
 */
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  refused: new Set<string>(),
  space: null as null | Record<string, unknown>,
  placement: { ok: true } as { ok: boolean; reason?: string; space?: unknown },
  createSpace: vi.fn(),
  deleteSpace: vi.fn(),
  setAgentSpace: vi.fn(),
  updateSpace: vi.fn(),
  listSpaces: vi.fn(),
  notes: {
    list: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    remove: vi.fn(),
  },
}));

const SPACE = {
  id: 'space-1',
  oxyUserId: 'owner-1',
  name: 'Marketing',
  instructions: '',
  conversationId: 'conv-1',
  memberAgentIds: [] as string[],
  createdAt: new Date('2026-11-10T00:00:00Z'),
  updatedAt: new Date('2026-11-10T00:00:00Z'),
};

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { user: { id: 'owner-1' }, accessToken: 'TOKEN' });
    next();
  },
}));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../lib/agent-account.js', () => ({
  loadAgentForActor: vi.fn(async (_db: unknown, input: { agentId: string }) =>
    state.refused.has(input.agentId)
      ? { ok: false, refusal: 'not_permitted' }
      : { ok: true, agent: { _id: input.agentId } },
  ),
  refusalMessage: () => 'refused',
  refusalStatus: () => 403,
}));
vi.mock('../../db/spaces/spaceRepository.js', () => ({
  createSpace: state.createSpace,
  deleteSpace: state.deleteSpace,
  setAgentSpace: state.setAgentSpace,
  updateSpace: state.updateSpace,
  listSpaces: state.listSpaces,
  findSpace: vi.fn(async () => state.space),
}));
class NotesConflict extends Error {
  constructor(
    readonly currentHash: string,
    readonly currentContent: string,
  ) {
    super('The notes changed since they were read');
  }
}
vi.mock('../../db/spaces/spaceMemoryRepository.js', () => ({
  SpaceNotesConflictError: NotesConflict,
  listSpaceNotes: state.notes.list,
  readSpaceNotes: state.notes.read,
  writeSpaceNotes: state.notes.write,
  deleteSpaceNotes: state.notes.remove,
}));
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { chat: child, general: child } };
});

const { default: router } = await import('../spaces.js');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/spaces', router);
let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}/spaces${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

beforeEach(() => {
  state.refused = new Set();
  state.space = { ...SPACE, memberAgentIds: ['a1'] };
  state.placement = { ok: true };
  state.createSpace.mockReset().mockResolvedValue({ ...SPACE });
  state.deleteSpace.mockReset().mockResolvedValue(true);
  state.updateSpace.mockReset().mockResolvedValue({ ...SPACE, name: 'New' });
  state.listSpaces.mockReset().mockResolvedValue([{ ...SPACE }]);
  state.setAgentSpace.mockReset().mockImplementation(async () => state.placement);
  for (const fn of Object.values(state.notes)) fn.mockReset();
});

describe('POST /spaces', () => {
  it('creates a space with a trimmed name and puts the named agents in, in order', async () => {
    const res = await call('POST', '/', { name: '  Marketing  ', agentIds: ['a1', 'a2'] });

    expect(res.status).toBe(201);
    expect(state.createSpace).toHaveBeenCalledWith(
      {},
      { oxyUserId: 'owner-1', name: 'Marketing', instructions: '' },
    );
    expect(state.setAgentSpace.mock.calls.map((c) => c[1].agentId)).toEqual(['a1', 'a2']);
    expect(res.body.space.conversationId).toBe('conv-1');
  });

  it('writes nothing when the caller has no standing over one of the agents', async () => {
    state.refused.add('a2');

    const res = await call('POST', '/', { name: 'Marketing', agentIds: ['a1', 'a2'] });

    expect(res.status).toBe(403);
    expect(state.createSpace).not.toHaveBeenCalled();
    expect(state.setAgentSpace).not.toHaveBeenCalled();
  });

  it('removes the space it just made when an agent cannot be placed, rather than leave an empty one', async () => {
    state.placement = { ok: false, reason: 'space_full' };

    const res = await call('POST', '/', { name: 'Marketing', agentIds: ['a1'] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('space_full');
    expect(state.deleteSpace).toHaveBeenCalledWith({}, 'owner-1', 'space-1');
  });

  it('refuses a missing or oversized name, an unknown field, and too many agents', async () => {
    expect((await call('POST', '/', {})).status).toBe(400);
    expect((await call('POST', '/', { name: '   ' })).status).toBe(400);
    expect((await call('POST', '/', { name: 'x'.repeat(61) })).status).toBe(400);
    expect((await call('POST', '/', { name: 'Ok', owner: 'someone-else' })).status).toBe(400);
    expect(
      (await call('POST', '/', { name: 'Ok', agentIds: ['1', '2', '3', '4', '5', '6', '7'] }))
        .status,
    ).toBe(400);
    expect(state.createSpace).not.toHaveBeenCalled();
  });
});

describe('PATCH /spaces/:id', () => {
  it('renames and rewrites the brief', async () => {
    const res = await call('PATCH', '/space-1', { name: ' New ', instructions: ' Focus ' });

    expect(res.status).toBe(200);
    expect(state.updateSpace).toHaveBeenCalledWith({}, 'owner-1', 'space-1', {
      name: 'New',
      instructions: 'Focus',
    });
  });

  it('is the same 404 for a space that is not the caller’s', async () => {
    state.updateSpace.mockResolvedValue(null);
    expect((await call('PATCH', '/space-9', { name: 'x' })).status).toBe(404);
  });

  it('refuses an invalid name or brief, and any other field', async () => {
    expect((await call('PATCH', '/space-1', { name: '' })).status).toBe(400);
    expect((await call('PATCH', '/space-1', { instructions: 5 })).status).toBe(400);
    expect((await call('PATCH', '/space-1', { conversationId: 'steal' })).status).toBe(400);
    expect(state.updateSpace).not.toHaveBeenCalled();
  });
});

describe('PUT /spaces/:id/members/:agentId', () => {
  it('puts the agent in the space', async () => {
    state.placement = { ok: true, space: { ...SPACE, memberAgentIds: ['a1'] } };

    const res = await call('PUT', '/space-1/members/a1');

    expect(res.status).toBe(200);
    expect(state.setAgentSpace).toHaveBeenCalledWith(
      {},
      { oxyUserId: 'owner-1', agentId: 'a1', spaceId: 'space-1' },
    );
    expect(res.body.space.memberAgentIds).toEqual(['a1']);
  });

  it('says a space that is not the caller’s does not exist, before asking about the agent', async () => {
    state.space = null;
    state.refused.add('a1');

    const res = await call('PUT', '/space-9/members/a1');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Space not found');
    expect(state.setAgentSpace).not.toHaveBeenCalled();
  });

  it('refuses an agent the caller has no standing over', async () => {
    state.refused.add('a1');
    expect((await call('PUT', '/space-1/members/a1')).status).toBe(403);
    expect(state.setAgentSpace).not.toHaveBeenCalled();
  });

  it('answers 409 for a full space and for an agent in another person’s space', async () => {
    state.placement = { ok: false, reason: 'space_full' };
    expect((await call('PUT', '/space-1/members/a1')).body.code).toBe('space_full');
    state.placement = { ok: false, reason: 'agent_in_other_space' };
    const other = await call('PUT', '/space-1/members/a1');
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('agent_in_other_space');
  });
});

describe('DELETE /spaces/:id/members/:agentId', () => {
  it('takes an agent out of the space it is in', async () => {
    const res = await call('DELETE', '/space-1/members/a1');

    expect(res.status).toBe(204);
    expect(state.setAgentSpace).toHaveBeenCalledWith(
      {},
      { oxyUserId: 'owner-1', agentId: 'a1', spaceId: null },
    );
  });

  it('is a 404 for an agent that is not in that space, and changes nothing', async () => {
    expect((await call('DELETE', '/space-1/members/a-elsewhere')).status).toBe(404);
    expect(state.setAgentSpace).not.toHaveBeenCalled();
  });
});

describe('GET and DELETE /spaces', () => {
  it('lists the caller’s spaces with their members and room', async () => {
    const res = await call('GET', '/');
    expect(res.status).toBe(200);
    expect(res.body.spaces[0]).toMatchObject({ id: 'space-1', conversationId: 'conv-1' });
    expect(state.listSpaces).toHaveBeenCalledWith({}, 'owner-1');
  });

  it('deletes a space, and 404s on one that is not the caller’s', async () => {
    expect((await call('DELETE', '/space-1')).status).toBe(204);
    state.deleteSpace.mockResolvedValue(false);
    expect((await call('DELETE', '/space-9')).status).toBe(404);
  });
});

describe('/spaces/:id/notes', () => {
  it('lists the files of the caller’s space', async () => {
    state.notes.list.mockResolvedValue([{ path: 'MEMORY.md', byteLength: 3 }]);
    const res = await call('GET', '/space-1/notes');
    expect(res.status).toBe(200);
    expect(res.body.documents).toEqual([{ path: 'MEMORY.md', byteLength: 3 }]);
    expect(state.notes.list).toHaveBeenCalledWith({}, 'space-1');
  });

  it('reads a file with the hash a write must name, the index by default', async () => {
    state.notes.read.mockResolvedValue({
      content: '- a',
      contentHash: 'h1',
      lastEditor: 'agent-1',
    });
    const res = await call('GET', '/space-1/notes?path=MEMORY.md');
    expect(res.body).toMatchObject({ path: 'MEMORY.md', content: '- a', hash: 'h1', exists: true });
    expect(res.body.lastEditor).toBe('agent-1');
  });

  it('says a file that does not exist is empty, with the hash of nothing', async () => {
    state.notes.read.mockResolvedValue(undefined);
    const res = await call('GET', '/space-1/notes?path=memory/x.md');
    expect(res.body).toMatchObject({ content: '', exists: false, lastEditor: null });
    expect(typeof res.body.hash).toBe('string');
  });

  it('is the same 404 for a space that is not the caller’s, on every verb', async () => {
    state.space = null;
    expect((await call('GET', '/space-9/notes')).status).toBe(404);
    expect(
      (await call('PUT', '/space-9/notes', { path: 'MEMORY.md', content: 'x', expectedHash: 'h' }))
        .status,
    ).toBe(404);
    expect((await call('DELETE', '/space-9/notes?path=MEMORY.md')).status).toBe(404);
    expect(state.notes.write).not.toHaveBeenCalled();
    expect(state.notes.remove).not.toHaveBeenCalled();
  });

  it('saves as the person, with the hash it read, and redacts secrets from what was typed', async () => {
    state.notes.write.mockResolvedValue({ id: 'd1' });

    const res = await call('PUT', '/space-1/notes', {
      path: 'MEMORY.md',
      // Built at run time so that no key-shaped literal sits in the repository for the scanner to ledger.
      content: `key ${['sk-ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ'].join('-')} done`,
      expectedHash: 'h1',
    });

    expect(res.status).toBe(200);
    const written = state.notes.write.mock.calls[0]![1];
    expect(written).toMatchObject({
      spaceId: 'space-1',
      path: 'MEMORY.md',
      expectedHash: 'h1',
      editor: 'person',
    });
    expect(written.content).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(res.body.redactedSecrets.length).toBeGreaterThan(0);
  });

  it('answers 409 with what the file holds now when another writer got there first', async () => {
    state.notes.write.mockRejectedValue(new NotesConflict('h2', 'newer'));

    const res = await call('PUT', '/space-1/notes', {
      path: 'MEMORY.md',
      content: 'x',
      expectedHash: 'h1',
    });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ currentHash: 'h2', currentContent: 'newer' });
  });

  it('refuses a write without the hash it read, an oversized file and a path outside the contract', async () => {
    expect((await call('PUT', '/space-1/notes', { path: 'MEMORY.md', content: 'x' })).status).toBe(
      400,
    );
    expect(
      (
        await call('PUT', '/space-1/notes', {
          path: 'MEMORY.md',
          content: 'x'.repeat(300 * 1024),
          expectedHash: 'h',
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await call('PUT', '/space-1/notes', {
          path: '../escape.md',
          content: 'x',
          expectedHash: 'h',
        })
      ).status,
    ).toBe(400);
    expect(state.notes.write).not.toHaveBeenCalled();
  });

  it('removes one file', async () => {
    state.notes.remove.mockResolvedValue(1);
    const res = await call('DELETE', '/space-1/notes?path=memory/old.md');
    expect(res.body).toEqual({ removed: 1 });
    expect(state.notes.remove).toHaveBeenCalledWith({}, 'space-1', 'memory/old.md');
  });
});
