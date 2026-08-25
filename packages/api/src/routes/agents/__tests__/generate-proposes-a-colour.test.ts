/**
 * `POST /agents/generate` proposes a COLOUR, and never a colour nobody offered.
 *
 * The colour is the only visual identity an agent has — there is no avatar any
 * more — so it is proposed at the same moment as the name and the handle, and
 * by the same call. What makes this worth a test rather than a line of review
 * is the failure mode: a model asked for a closed vocabulary invents members of
 * it, and an invented Bloom preset key is not an error anywhere. It travels to
 * Oxy, Oxy stores the string, and every consumer falls back to a default
 * colour — so the agent renders in the wrong colour with nothing red anywhere.
 *
 * A REAL express server, because the subject is what the ROUTE answers. Only
 * the model is a fixture: `generateText` is replaced with whatever JSON the
 * case wants the model to have produced.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  /** Exactly what the model answered with, verbatim, including the wrapper. */
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
  getDefaultAliaModel: () => 'alia-v1',
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
const { AGENT_COLORS, agentColorFor } = await import('../../../domain/agent-color.js');

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

/** The fields the route reads, with the colour left to each case. */
function modelAnswer(over: Record<string, unknown>): string {
  return JSON.stringify({
    name: 'Deep Reader',
    tagline: 'reads things',
    description: 'a description',
    systemPrompt: 'you read things',
    category: 'Research',
    tags: ['reading'],
    capabilityGrants: ['web'],
    archetype: 'qa',
    ...over,
  });
}

async function generate(): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/agents/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'an agent that reads long documents' }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  state.modelText = modelAnswer({});
  state.systemPrompt = '';
});

describe('the generator proposes a colour', () => {
  it('offers the vocabulary to the model at all', async () => {
    // The floor. Every assertion below is about what comes BACK, and all of
    // them would still pass with the colour silently dropped from the prompt —
    // the fallback would answer every one of them.
    await generate();

    expect(state.systemPrompt).toContain('"color"');
    for (const colour of AGENT_COLORS) expect(state.systemPrompt).toContain(`"${colour}"`);
  });

  it('passes through a colour the model was offered', async () => {
    // Deliberately NOT the colour `deep-reader` falls back to: a fixture that
    // collides with the fallback passes whether the passthrough works or not.
    state.modelText = modelAnswer({ color: 'mint' });

    expect(agentColorFor('deep-reader')).not.toBe('mint');
    expect((await generate()).color).toBe('mint');
  });

  it('answers an OFFERED colour when the model invents one', async () => {
    // The case this file exists for. `chartreuse` is not a Bloom preset, and
    // nothing downstream would refuse it: Oxy stores the string and every
    // renderer falls back, so the agent is simply the wrong colour forever.
    state.modelText = modelAnswer({ color: 'chartreuse' });
    const body = await generate();

    expect(body.color).not.toBe('chartreuse');
    expect(AGENT_COLORS).toContain(body.color);
  });

  it('answers an offered colour when the model names none at all', async () => {
    state.modelText = modelAnswer({});
    const body = await generate();

    expect(typeof body.color).toBe('string');
    expect(AGENT_COLORS).toContain(body.color);
  });

  /**
   * The fallback is DERIVED, not drawn.
   *
   * A random fallback passes every assertion above and is still wrong: asking
   * twice for the same agent would propose two different colours, and the
   * person watching the form would see one replace the other for no reason
   * they could name.
   */
  it('falls back to the same colour every time for the same handle', async () => {
    state.modelText = modelAnswer({ color: 'not-a-preset' });
    const first = await generate();
    const second = await generate();

    expect(first.color).toBe(second.color);
    expect(first.color).toBe(agentColorFor(first.suggestedUsername as string));
  });

  it('the fallback is not one fixed colour for every agent', async () => {
    // Otherwise "derived from the handle" and "hardcoded to teal" are the same
    // observation, and the assertion above holds for both.
    const colours = new Set(
      ['reader', 'scout', 'analyst', 'poet', 'courier', 'auditor'].map(agentColorFor),
    );
    expect(colours.size).toBeGreaterThan(1);
  });
});

/**
 * The catalogue Oxy will actually STORE, restated.
 *
 * `USER_COLOR_PRESETS` in the Oxy server's `db/schema/users.ts`, which renders
 * the CHECK constraint `users_color_check`. Restated rather than imported
 * because the server deliberately publishes no copy of it: `@oxyhq/contracts`
 * types the field as a plain string and says so — "pinning the list a second
 * time in this package would be a second source of truth for what the database
 * accepts, and the two would drift apart silently".
 *
 * A local copy CAN go stale, and it is worth being precise about which way:
 * the constraint is append-only, so a key added upstream is missing here and
 * this test fails on a colour that would in fact have worked. It cannot fail
 * the other way — it can never call a refused colour storable. Wrongly red,
 * never wrongly green, which is the direction a restatement is allowed to err.
 */
const OXY_STORABLE_COLORS = [
  'teal',
  'blue',
  'green',
  'amber',
  'red',
  'purple',
  'pink',
  'sky',
  'orange',
  'mint',
  'oxy',
];

describe('every colour the generator can propose is one Oxy will store', () => {
  /**
   * The offer is not free. A proposed colour travels to `POST /accounts` and
   * lands in a column with a CHECK on it, so a key this service offers but the
   * constraint omits is not a cosmetic mismatch — it is a 400 on the save, for
   * a value the person was handed by us and never typed.
   */
  it('offers no colour outside the server catalogue', () => {
    expect(OXY_STORABLE_COLORS).toEqual(expect.arrayContaining([...AGENT_COLORS]));
  });

  /**
   * The same invariant one layer out, at the route. The assertion above holds
   * on the LIST; this one holds on what the response actually carries, so it
   * still fails if the passthrough stops consulting the list at all.
   */
  it.each(['yellow', 'rose', 'violet', 'brown'])(
    'does not pass %s through to the response',
    async (refused) => {
      state.modelText = modelAnswer({ color: refused });
      const body = await generate();

      expect(body.color).not.toBe(refused);
      expect(OXY_STORABLE_COLORS).toContain(body.color);
    },
  );
});
