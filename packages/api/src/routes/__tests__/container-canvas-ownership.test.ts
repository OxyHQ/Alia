import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The owner id reaching the container and canvas repositories.
 *
 * Both routers ran their filters with an OPTIONAL owner: `req.user?.id` and
 * `req.userId` are `string | undefined`, and Mongo DROPS an `undefined` key from
 * a filter — so a request that reached one of these handlers without an
 * authenticated user would have matched EVERY account's row rather than none.
 * `authenticateToken` is mounted on both routers, so the state was unreachable;
 * these cases are what stops it becoming reachable again, because the fault it
 * produces is a cross-account read that returns 200.
 *
 * The repositories are mocked: what reaches them is this file's question, and
 * what the statements then do is the pgdb suites'.
 */

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../db/agents/containerRepository.js', () => ({
  deleteOwnedContainerTemplate: vi.fn(),
  findOwnedContainer: vi.fn(),
  listOwnedContainerTemplates: vi.fn(),
  listOwnedContainers: vi.fn(),
  markContainerDestroyed: vi.fn(),
}));

vi.mock('../../db/chat/canvasSessionRepository.js', () => ({
  deleteCanvasSession: vi.fn(),
  findCanvasComponents: vi.fn(),
}));

vi.mock('../../lib/container-manager.js', () => ({ destroyContainer: vi.fn() }));

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../../lib/logger.js', () => ({
  log: {
    general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    canvas: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import {
  deleteOwnedContainerTemplate,
  findOwnedContainer,
  listOwnedContainerTemplates,
  listOwnedContainers,
  markContainerDestroyed,
} from '../../db/agents/containerRepository.js';
import {
  deleteCanvasSession,
  findCanvasComponents,
} from '../../db/chat/canvasSessionRepository.js';
import containersRouter from '../containers.js';
import canvasRouter from '../canvas/sessions.js';

type Handler = (req: Record<string, unknown>, res: MockResponse) => Promise<unknown>;

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: Handler }[];
  };
}

function handlerFor(
  router: unknown,
  method: 'get' | 'delete',
  path: string,
): Handler {
  const layers = (router as { stack: RouteLayer[] }).stack;
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

const USER_ID = 'oxy-user-1';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listOwnedContainers).mockResolvedValue([]);
  vi.mocked(listOwnedContainerTemplates).mockResolvedValue([]);
  vi.mocked(findOwnedContainer).mockResolvedValue(undefined);
  vi.mocked(markContainerDestroyed).mockResolvedValue(1);
  vi.mocked(deleteOwnedContainerTemplate).mockResolvedValue(1);
  vi.mocked(findCanvasComponents).mockResolvedValue(undefined);
  vi.mocked(deleteCanvasSession).mockResolvedValue(1);
});

describe('every container handler refuses an unauthenticated request', () => {
  const cases: ReadonlyArray<[string, 'get' | 'delete', string, () => unknown]> = [
    ['GET /', 'get', '/', () => listOwnedContainers],
    ['GET /:id', 'get', '/:id', () => findOwnedContainer],
    ['DELETE /:id', 'delete', '/:id', () => findOwnedContainer],
    ['GET /templates/list', 'get', '/templates/list', () => listOwnedContainerTemplates],
    ['DELETE /templates/:id', 'delete', '/templates/:id', () => deleteOwnedContainerTemplate],
  ];

  for (const [label, method, path, repositoryFn] of cases) {
    it(`${label} answers 401 and issues no query`, async () => {
      const res = makeRes();
      await handlerFor(containersRouter, method, path)({ params: { id: 'c1' } }, res);

      expect(res.statusCode).toBe(401);
      expect(vi.mocked(repositoryFn() as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it(`${label} carries the authenticated id into the repository`, async () => {
      // The positive control. Without it the 401 case above is also what a
      // handler that answers 401 unconditionally would report.
      const res = makeRes();
      await handlerFor(containersRouter, method, path)(
        { user: { id: USER_ID }, params: { id: 'c1' } },
        res,
      );

      expect(res.statusCode).not.toBe(401);
      const fn = vi.mocked(repositoryFn() as ReturnType<typeof vi.fn>);
      expect(fn).toHaveBeenCalled();
      // The owner is the LAST argument of every one of these signatures.
      const args = fn.mock.calls[0] ?? [];
      expect(args[args.length - 1]).toBe(USER_ID);
    });
  }
});

describe('destroying a container', () => {
  it('scopes the destroy to the caller and skips it for an already-destroyed row', async () => {
    vi.mocked(findOwnedContainer).mockResolvedValue({
      containerId: 'c1',
      status: 'destroyed',
    } as never);

    const res = makeRes();
    await handlerFor(containersRouter, 'delete', '/:id')(
      { user: { id: USER_ID }, params: { id: 'c1' } },
      res,
    );

    expect(res.body).toEqual({ destroyed: true });
    expect(vi.mocked(markContainerDestroyed)).not.toHaveBeenCalled();

    // A LIVE container does get destroyed, and with the caller's id.
    vi.mocked(findOwnedContainer).mockResolvedValue({
      containerId: 'c1',
      status: 'running',
    } as never);
    await handlerFor(containersRouter, 'delete', '/:id')(
      { user: { id: USER_ID }, params: { id: 'c1' } },
      makeRes(),
    );
    expect(vi.mocked(markContainerDestroyed)).toHaveBeenCalledWith({}, 'c1', USER_ID);
  });

  it('answers 404 when the container is not this account\'s', async () => {
    vi.mocked(findOwnedContainer).mockResolvedValue(undefined);
    const res = makeRes();
    await handlerFor(containersRouter, 'delete', '/:id')(
      { user: { id: USER_ID }, params: { id: 'c1' } },
      res,
    );
    expect(res.statusCode).toBe(404);
    expect(vi.mocked(markContainerDestroyed)).not.toHaveBeenCalled();
  });
});

describe('deleting a template', () => {
  it('reports 404 off a ZERO count, not off a returned row', async () => {
    vi.mocked(deleteOwnedContainerTemplate).mockResolvedValue(0);
    const res = makeRes();
    await handlerFor(containersRouter, 'delete', '/templates/:id')(
      { user: { id: USER_ID }, params: { id: 't1' } },
      res,
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('canvas handlers', () => {
  it('refuse an unauthenticated request and issue no query', async () => {
    const get = makeRes();
    await handlerFor(canvasRouter, 'get', '/:conversationId')(
      { params: { conversationId: 'conv-1' } },
      get,
    );
    expect(get.statusCode).toBe(401);
    expect(vi.mocked(findCanvasComponents)).not.toHaveBeenCalled();

    const del = makeRes();
    await handlerFor(canvasRouter, 'delete', '/:conversationId')(
      { params: { conversationId: 'conv-1' } },
      del,
    );
    expect(del.statusCode).toBe(401);
    expect(vi.mocked(deleteCanvasSession)).not.toHaveBeenCalled();
  });

  it('carry the authenticated id, and collapse "no canvas" to an empty list', async () => {
    const res = makeRes();
    await handlerFor(canvasRouter, 'get', '/:conversationId')(
      { userId: USER_ID, params: { conversationId: 'conv-1' } },
      res,
    );

    expect(vi.mocked(findCanvasComponents)).toHaveBeenCalledWith({}, USER_ID, 'conv-1');
    // `undefined` (no session) and `[]` (an empty one) are different facts in
    // the repository and one answer on the wire, which is what the route did.
    expect(res.body).toEqual({ components: [] });

    vi.mocked(findCanvasComponents).mockResolvedValue([]);
    const empty = makeRes();
    await handlerFor(canvasRouter, 'get', '/:conversationId')(
      { userId: USER_ID, params: { conversationId: 'conv-1' } },
      empty,
    );
    expect(empty.body).toEqual({ components: [] });
  });

  it('delete answers 200 whether or not there was a canvas', async () => {
    vi.mocked(deleteCanvasSession).mockResolvedValue(0);
    const res = makeRes();
    await handlerFor(canvasRouter, 'delete', '/:conversationId')(
      { userId: USER_ID, params: { conversationId: 'conv-1' } },
      res,
    );
    expect(res.body).toEqual({ success: true });
    expect(vi.mocked(deleteCanvasSession)).toHaveBeenCalledWith({}, USER_ID, 'conv-1');
  });
});
