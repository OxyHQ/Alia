/**
 * `GET /agents/:id/reviews` — the page window can never be `NaN`.
 *
 * The route clamped its own query parameters and, alone among the listings in
 * this package, did it without a default:
 *
 *   Math.min(50, Math.max(1, parseInt(limit as string, 10)))
 *
 * `parseInt('abc', 10)` is `NaN`, and BOTH `Math.max(1, NaN)` and
 * `Math.min(50, NaN)` are `NaN` — the clamp looks like it bounds the value and
 * does not. So `?limit=abc` reached the repository as `limit: NaN`, and
 * `offset: (pageNum - 1) * limitNum` was `NaN` too. Every sibling listing
 * (`activity.ts`, `sessions.ts`, `crud.ts`, `audit.ts`) already carried the
 * `|| <default>` guard; this one was the exception, which is the shape of bug a
 * copied idiom produces when one copy is edited.
 *
 * The repository is the assertion point rather than the response: what matters
 * is the value that reaches the QUERY, and a route that passed `NaN` down could
 * still return a plausible-looking body depending on how the driver coerced it.
 */

import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  /** Every `{ limit, offset }` the route handed the repository. */
  windows: [] as Array<{ limit: unknown; offset: unknown }>,
}));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));

vi.mock('../../../db/agents/agentRepository.js', () => ({
  findAgentById: vi.fn(async () => ({ id: 'agent-1', access: 'public', isPublished: true })),
}));

vi.mock('../../../db/agents/agentReviewRepository.js', () => ({
  listVisibleAgentReviews: vi.fn(async (_db: unknown, _agentId: string, window: { limit: unknown; offset: unknown }) => {
    state.windows.push({ limit: window.limit, offset: window.offset });
    return { reviews: [], total: 0 };
  }),
  deleteOwnAgentReview: vi.fn(),
  findOwnAgentReview: vi.fn(),
  recalculateAgentRating: vi.fn(),
  upsertAgentReview: vi.fn(),
}));

vi.mock('../../../lib/oxy-user-hydration.js', () => ({ hydrateOxyUsers: vi.fn(async () => new Map()) }));

vi.mock('../../../middleware/auth.js', () => ({
  optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  authenticateToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

let app: Express;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const reviews = (await import('../reviews.js')).default;
  app = express();
  app.use(express.json());
  app.use('/agents', reviews);
  // A real listening server rather than supertest, which this package does not
  // depend on — the same harness `hire-access.test.ts` uses.
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

/** GET the listing with a raw query string, asserting it answered 200. */
async function reviews(query: string): Promise<void> {
  const res = await fetch(`${baseUrl}/agents/agent-1/reviews?${query}`);
  expect(res.status, `unexpected status for ?${query}`).toBe(200);
  await res.json();
}

beforeEach(() => {
  state.windows.length = 0;
});

describe('GET /agents/:id/reviews page window', () => {
  it('never passes NaN down, whatever the query says', async () => {
    // Each of these produced `NaN` for both `limit` and `offset` before the
    // guard. They are separate cases rather than one loop assertion so a
    // failure names the input that broke it.
    for (const query of [
      'limit=abc',
      'page=abc',
      'limit=abc&page=abc',
      'limit=',
      'limit=Infinity',
      'limit=1e999',
    ]) {
      state.windows.length = 0;
      await reviews(query);

      const [window] = state.windows;
      expect(window, `no repository call for ?${query}`).toBeDefined();
      expect(Number.isInteger(window.limit), `limit for ?${query}`).toBe(true);
      expect(Number.isInteger(window.offset), `offset for ?${query}`).toBe(true);
      expect(window.limit as number).toBeGreaterThanOrEqual(1);
      expect(window.limit as number).toBeLessThanOrEqual(50);
      expect(window.offset as number).toBeGreaterThanOrEqual(0);
    }
  });

  it('still honours a valid window, and still caps it', async () => {
    await reviews('page=3&limit=10');
    expect(state.windows[0]).toEqual({ limit: 10, offset: 20 });

    state.windows.length = 0;
    // The cap is the reason the clamp exists; a guard that fixed `NaN` while
    // dropping the ceiling would let a caller ask for the whole table.
    await reviews('limit=9999');
    expect(state.windows[0]).toEqual({ limit: 50, offset: 0 });
  });

  it('treats a repeated parameter as one value rather than a concatenation', async () => {
    // Express hands a repeated key over as an array, and `parseInt(String(['5',
    // '500']), 10)` is `parseInt('5,500', 10)` = 5. Not a crash, and not
    // obviously wrong — which is why it is pinned rather than left to chance.
    await reviews('limit=5&limit=500');
    const [window] = state.windows;
    expect(Number.isInteger(window.limit)).toBe(true);
    expect(window.limit as number).toBeLessThanOrEqual(50);
  });
});
