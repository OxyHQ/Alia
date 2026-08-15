import { describe, expect, it, vi } from 'vitest';

/**
 * One product runtime behind every chat surface — epic #139 workstream 13,
 * "Preserve one unified Alia product runtime for app, Codea, Cowork and
 * supported surfaces where behavior is intentionally shared".
 *
 * ## Why an identity check and not another transcript
 *
 * `chatFlowFixtures.test.ts` records what the app, Codea and Cowork flows emit,
 * and all three drive `handleChatCompletions` — because all three POST to
 * `/v1/chat/completions`. What no test asks is whether the ROUTES still resolve
 * to that one function. `/alia/chat` is a second public surface
 * (`routes/chat.ts`), and the sentence in that file — "internal chat now uses
 * the same handler" — is a comment, not a constraint.
 *
 * Forking it is a two-line change that breaks nothing loudly: the fixtures keep
 * passing because they import the handler directly, and the app keeps working
 * because it uses the other surface. What drifts is everything the epic is
 * trying to preserve — memory recall, the tool pipeline, credits, the SSE event
 * names — on whichever surface stopped being the shared one.
 *
 * So the assertion is function IDENTITY: the same object, reached from both
 * routers. That is a claim no amount of behavioural duplication would make, and
 * it is the claim the checkbox actually makes.
 */

vi.mock('../../middleware/auth.js', () => ({
  oxyClient: { getUserById: vi.fn(async () => null), authSocket: vi.fn() },
  optionalAuth: vi.fn((_r: unknown, _s: unknown, next: () => void) => next()),
  authenticateToken: vi.fn((_r: unknown, _s: unknown, next: () => void) => next()),
  authenticateTokenOrApiKey: vi.fn((_r: unknown, _s: unknown, next: () => void) => next()),
}));

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

import chatCompletionsRouter, { handleChatCompletions } from '../v1/chat-completions.js';
import aliaChatRouter from '../chat.js';

/** Express keeps one layer per mounted route; this reads the handler off one. */
interface RouteLayer {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
    stack: Array<{ handle: unknown; name?: string }>;
  };
}

function postHandlers(router: unknown, routePath: string): unknown[] {
  const stack = (router as { stack: RouteLayer[] }).stack;
  const layer = stack.find((entry) => entry.route?.path === routePath && entry.route.methods?.post === true);
  expect(layer?.route, `POST ${routePath} is not mounted on this router`).toBeDefined();
  return (layer?.route?.stack ?? []).map((entry) => entry.handle);
}

describe('both public chat surfaces run the same handler object', () => {
  it('serves /v1/chat/completions with it', () => {
    const handlers = postHandlers(chatCompletionsRouter, '/');
    // The floor: a layer with an empty handler stack would make `toContain`
    // below a statement about an empty array.
    expect(handlers.length).toBeGreaterThan(0);
    expect(handlers).toContain(handleChatCompletions);
  });

  it('serves /alia/chat with the SAME object, not a copy of its behaviour', () => {
    const handlers = postHandlers(aliaChatRouter, '/');
    expect(handlers.length).toBeGreaterThan(0);
    // Reference equality. A re-implementation, a wrapper that re-exports, or a
    // fork that starts identical would all fail here — which is the point,
    // because each of them can then diverge silently.
    expect(handlers).toContain(handleChatCompletions);
  });

  it('the identity check can fail (the control)', () => {
    // "Contains the handler" is also what a check comparing an array against
    // itself reports. A different function of the same shape is not found.
    const lookalike = async (): Promise<void> => undefined;
    expect(postHandlers(aliaChatRouter, '/')).not.toContain(lookalike);
  });

  it('/alia/chat puts its auth middleware in front of the shared handler', async () => {
    // The surfaces share the runtime AND the session model: an anonymous caller
    // reaches the same handler with no user, which is what makes the handler's
    // own `isDirectUserSession` branch the single place that decides what a
    // session may do (`lib/chat/request-context.ts:160`). A surface that lost
    // its middleware would reach the handler with a session it never checked.
    const { optionalAuth } = await import('../../middleware/auth.js');
    const handlers = postHandlers(aliaChatRouter, '/');
    expect(handlers).toEqual([optionalAuth, handleChatCompletions]);
  });
});
