/**
 * `POST /agents/generate` proposes an ACCOUNT CATEGORY, and never one Oxy has
 * not heard of.
 *
 * Two categories exist and they are not the same question, which is the thing
 * most likely to be mistaken by whoever reads this next:
 *
 *  - `category` is Alia's own, FREE TEXT, and feeds the catalogue's `ilike`
 *    search (`agentRepository.ts`). Nothing renders it.
 *  - `accountCategory` is Oxy's, a CLOSED taxonomy in `@oxyhq/contracts`, and
 *    travels to `CreateAccountInput.accountCategories` where the account graph
 *    and every profile surface outside Alia can read it.
 *
 * Merging them would cost the search its free text or hand Oxy an id it does
 * not know. So both stay, and this file is about the second.
 *
 * They are allowed to DISAGREE — a Developer agent about `finance` is the right
 * answer, not a bug — and that is asserted below rather than left to a comment.
 *
 * As with the colour beside it, the model is a fixture: `generateText` is
 * replaced with whatever JSON a case wants, so what is under test is the
 * route's handling and not a model's good behaviour.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  modelText: '',
  /** The system prompt the route built, so "was the vocabulary even sent" is assertable. */
  systemPrompt: '',
}));

vi.mock('ai', () => ({
  generateText: vi.fn(async (options: { messages: { role: string; content: string }[] }) => {
    state.systemPrompt = options.messages.find((m) => m.role === 'system')?.content ?? '';
    return { text: state.modelText };
  }),
}));

vi.mock('../../../lib/chat-core.js', () => ({
  resolveModel: async () => ({ provider: 'p', modelId: 'm', keyConfig: { keyId: 'k' } }),
  getAIModel: () => ({}),
  getDefaultRoutingProfile: () => 'kaana-v1',
}));

vi.mock('../../../middleware/auth.js', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: { id: string } }).user = { id: 'oxy-caller' };
    next();
  },
}));

vi.mock('../../../lib/logger.js', () => ({
  log: { agents: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const { default: generateRouter } = await import('../generate.js');
const { ACCOUNT_CATEGORY_IDS, isSelectableAccountCategoryId } = await import('@oxyhq/contracts');

let app: Express;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  app.use('/agents', generateRouter);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function modelAnswer(over: Record<string, unknown>): string {
  return JSON.stringify({
    name: 'Claudio',
    tagline: 'keeps the community honest',
    description: 'a description',
    systemPrompt: 'you keep things honest',
    category: 'Assistant',
    tags: ['community'],
    capabilityGrants: ['web'],
    archetype: 'general',
    ...over,
  });
}

async function generate(): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/agents/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'an agent that manages a community' }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  state.modelText = modelAnswer({});
  state.systemPrompt = '';
});

describe('the generator proposes an account category', () => {
  it('offers the vocabulary to the model at all', async () => {
    // The floor, and it is not decorative: every assertion below is about what
    // comes BACK, and all of them would pass with the field silently dropped
    // from the prompt — an omitted category answers each one.
    await generate();

    const selectable = ACCOUNT_CATEGORY_IDS.filter(isSelectableAccountCategoryId);
    expect(selectable.length).toBeGreaterThan(10);
    for (const id of selectable) {
      expect(state.systemPrompt).toContain(`"${id}"`);
    }
  });

  it('passes through a category the taxonomy recognises', async () => {
    state.modelText = modelAnswer({ accountCategory: 'technology' });

    expect(await generate()).toMatchObject({ accountCategory: 'technology' });
  });

  it('drops one the taxonomy does not, rather than correcting it', async () => {
    // The realistic failure: a model asked for a closed vocabulary invents a
    // plausible member of it. `community_management` reads like an id and is
    // not one, and a wrong category is worse than none.
    state.modelText = modelAnswer({ accountCategory: 'community_management' });

    expect(await generate()).not.toHaveProperty('accountCategory');
  });

  it('omits the field when the model offered none', async () => {
    // A valid state, and the one the prompt asks for when nothing fits. Absent
    // must stay absent: the client forwards this to `accountCategories`, where
    // an empty array would mean "clear them" rather than "there are none".
    expect(await generate()).not.toHaveProperty('accountCategory');
  });

  it.each([null, 42, '', 'ALL', ['technology']])(
    'drops %j, which is not an id either',
    async (value) => {
      state.modelText = modelAnswer({ accountCategory: value });

      expect(await generate()).not.toHaveProperty('accountCategory');
    },
  );

  it("still answers Alia's own free-text category, which is a different question", async () => {
    // The two must not collapse into one another: this one feeds the
    // catalogue's `ilike` search and is not drawn from Oxy's taxonomy.
    state.modelText = modelAnswer({ category: 'Research', accountCategory: 'science' });
    const body = await generate();

    expect(body).toMatchObject({ category: 'Research', accountCategory: 'science' });
  });

  it('lets the two disagree, because they are different axes', async () => {
    // The decision, asserted where a future "normalise them" would break it: an
    // agent that writes trading code IS a Developer and IS about finance, and
    // neither answer is derivable from the other. Both survive verbatim; any
    // rule that made one follow the other rewrites one of these two fields.
    state.modelText = modelAnswer({ category: 'Developer', accountCategory: 'finance' });
    const body = await generate();

    expect(body).toMatchObject({ category: 'Developer', accountCategory: 'finance' });
  });

  it('tells the model not to bother making them agree', async () => {
    // Without this the model harmonises them on its own — asked for a subject
    // right after a kind, it echoes the kind — and the divergence above stops
    // being reachable in production even though the route still allows it.
    await generate();

    expect(state.systemPrompt).toMatch(/they need not agree/i);
  });
});

describe('the name it asks for', () => {
  it('asks for a given name and rules out a job title', async () => {
    // Guidance, not a rule — "originality" is not checkable, and this asserts
    // that the ASK changed, which is the only part that is.
    await generate();

    expect(state.systemPrompt).toMatch(/given name/i);
    expect(state.systemPrompt).toContain('Community Manager');
    expect(state.systemPrompt).not.toMatch(/A short, memorable name/i);
  });
});
