import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The owner id reaching the canvas repository.
 *
 * (The container router this file also covered went with the sandbox docker
 * host; the file keeps its name.)
 *
 * The router ran its filters with an OPTIONAL owner: `req.user?.id` and
 * `req.userId` are `string | undefined`, and Mongo DROPS an `undefined` key from
 * a filter — so a request that reached one of these handlers without an
 * authenticated user would have matched EVERY account's row rather than none.
 * `authenticateToken` is mounted on the router, so the state was unreachable;
 * these cases are what stops it becoming reachable again, because the fault it
 * produces is a cross-account read that returns 200.
 *
 * The repository is mocked: what reaches it is this file's question, and
 * what the statements then do is the pgdb suites'.
 */

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../db/chat/canvasSessionRepository.js', () => ({
  deleteCanvasSession: vi.fn(),
  findCanvasComponents: vi.fn(),
}));

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
  deleteCanvasSession,
  findCanvasComponents,
} from '../../db/chat/canvasSessionRepository.js';
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
  vi.mocked(findCanvasComponents).mockResolvedValue(undefined);
  vi.mocked(deleteCanvasSession).mockResolvedValue(1);
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
