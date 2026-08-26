import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * `POST /suggestions/generate`, and the failure it was answering 500 with.
 *
 * ## What production was actually doing
 *
 * The route asked Kaana for eight suggestions inside a 2048-token output
 * ceiling. Kaana's product default is a REASONING model, and its reasoning is
 * spent from the same ceiling: measured against it on 2026-08-24, a complete
 * eight-item answer costs 1781-2560 output tokens of which 940-2066 are
 * reasoning, so the ceiling could not hold one. Six of ten sampled answers came
 * back cut off mid-item, and one spent the whole ceiling reasoning and returned
 * nothing at all. CloudWatch has 100 of these between 2026-08-23 15:39 UTC and
 * 2026-08-24 23:12 UTC and none before, because until #269 restored a usable
 * key the route had no model to be truncated by.
 *
 * The parse that followed matched from the first `[` to the last `]`. On a cut
 * off answer the last `]` closes an item's own `tags` array, so it always found
 * something and it was never the answer.
 *
 * ## The fixture
 *
 * {@link COMPLETE_ANSWER} is a real answer from that model to this route's real
 * prompt, captured on 2026-08-25: 3,390 characters, eight items. Sliced to
 * 3,022 it is byte-for-byte the length of the answer the production line
 * `responseChars: 3022` was reporting, and it fails to parse for the same
 * reason that one did.
 */

const COMPLETE_ANSWER = `{
  "suggestions": [
    {
      "title": "Spark a Short Story Idea",
      "text": "Write an inspiring flash fiction about a hidden garden",
      "description": "Kickstart your imagination with a quick, vivid tale.",
      "type": "welcome",
      "category": "creative",
      "language": "en-US",
      "triggerWords": ["Write"],
      "tags": ["writing", "creative"],
      "occupations": [],
      "interests": []
    },
    {
      "title": "Fix Python Syntax Errors",
      "text": "Help me identify and correct the syntax errors in this Python script",
      "description": "Get immediate assistance to clean up your code.",
      "type": "autocomplete",
      "category": "coding",
      "language": "en-US",
      "triggerWords": ["Help"],
      "tags": ["coding", "debug"],
      "occupations": [],
      "interests": []
    },
    {
      "title": "Organize Your Daily Tasks",
      "text": "Plan a structured to‑do list for a busy workday",
      "description": "Create a clear, prioritized schedule in minutes.",
      "type": "welcome",
      "category": "productivity",
      "language": "en-US",
      "triggerWords": ["Plan"],
      "tags": ["productivity", "planning"],
      "occupations": [],
      "interests": []
    },
    {
      "title": "Understand the Basics of Quantum Mechanics",
      "text": "Explain the core principles of quantum mechanics in simple terms",
      "description": "Break down complex concepts for beginners.",
      "type": "autocomplete",
      "category": "learning",
      "language": "en-US",
      "triggerWords": ["Explain"],
      "tags": ["science", "education"],
      "occupations": [],
      "interests": []
    },
    {
      "title": "Craft a Persuasive Email",
      "text": "Summarize my project updates into a concise, persuasive email",
      "description": "Turn details into compelling messages quickly.",
      "type": "welcome",
      "category": "communication",
      "language": "en-US",
      "triggerWords": ["Summarize"],
      "tags": ["writing", "email"],
      "occupations": [],
      "interests": []
    },
    {
      "title": "Design a Fantasy World",
      "text": "Create a vivid fantasy setting with unique cultures, geography, and magic systems",
      "description": "Build immersive worlds for storytelling.",
      "type": "autocomplete",
      "category": "creative",
      "language": "en-US",
      "triggerWords": ["Create"],
      "tags": ["worldbuilding", "creative"],
      "occupations": [],
      "interests": []
    },
    {
      "title": "Boost Your Vocabulary in English",
      "text": "Compare synonyms for common adjectives to enrich your speech",
      "description": "Expand word choice with side‑by‑side comparisons.",
      "type": "welcome",
      "category": "learning",
      "language": "en-US",
      "triggerWords": ["Compare"],
      "tags": ["language", "vocabulary"],
      "occupations": [],
      "interests": []
    },
    {
      "title": "Track Project Milestones",
      "text": "Generate a simple Gantt chart outline for a three‑month marketing campaign",
      "description": "Visualize timeline and key deliverables easily.",
      "type": "autocomplete",
      "category": "productivity",
      "language": "en-US",
      "triggerWords": ["Generate"],
      "tags": ["project-management", "planning"],
      "occupations": [],
      "interests": []
    }
  ]
}`;

/** The same answer, cut where the output ceiling cut the real one. */
const TRUNCATED_ANSWER = COMPLETE_ANSWER.slice(0, 3022);

const H = vi.hoisted(() => ({
  /** What Kaana answers, or `null` when it did not serve the call. */
  kaanaAnswer: null as string | null,
  /** Thrown instead, when the case is about Kaana failing rather than answering. */
  kaanaThrows: null as Error | null,
  /** The request the route handed Kaana, for asserting what was ASKED. */
  kaanaRequest: null as Record<string, unknown> | null,
  /** What the fallback model answers, and how it says it finished. */
  modelText: '',
  modelFinish: 'stop' as string,
  /** The options `generateObject` handed the fallback model. */
  modelCall: null as Record<string, unknown> | null,
  /** Whether a model can be resolved at all. */
  resolves: true,
}));

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../db/memory/userMemoryRepository.js', () => ({
  findUserMemory: vi.fn(async () => null),
}));

vi.mock('../../db/notifications/suggestionRepository.js', () => ({
  createSuggestion: vi.fn(async (_db: unknown, input: Record<string, unknown>) => ({ ...input })),
  deleteOwnSuggestion: vi.fn(),
  findOwnSuggestion: vi.fn(),
  incrementSuggestionUsage: vi.fn(),
  listOwnSuggestions: vi.fn(),
  listSuggestions: vi.fn(),
  listWelcomePool: vi.fn(),
  searchSuggestions: vi.fn(),
  updateOwnSuggestion: vi.fn(),
}));

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  optionalAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../../lib/memory/user-memory-service.js', () => ({
  getUserLanguage: vi.fn(async () => 'en-US'),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('../../lib/inference/kaana-text.js', () => ({
  generateTextViaKaana: vi.fn(async (request: Record<string, unknown>) => {
    H.kaanaRequest = request;
    if (H.kaanaThrows !== null) throw H.kaanaThrows;
    return H.kaanaAnswer;
  }),
}));

/**
 * The fallback model is a real `LanguageModelV3`, not a mocked `generateObject`.
 *
 * Mocking the SDK call would mock the parse, the validation and the error this
 * suite is about, leaving assertions that only measure the mock. This answers
 * with text the way a provider does and lets the SDK do everything it does in
 * production.
 */
vi.mock('../../lib/chat-core.js', () => ({
  resolveModel: vi.fn(async () => (H.resolves ? { provider: 'groq', keyConfig: { provider: 'groq' } } : null)),
  getAIModel: vi.fn(() => ({
    specificationVersion: 'v3',
    provider: 'kaana',
    modelId: 'test',
    supportedUrls: {},
    async doGenerate(call: Record<string, unknown>) {
      H.modelCall = call;
      return {
        content: H.modelText === '' ? [] : [{ type: 'text', text: H.modelText }],
        finishReason: { unified: H.modelFinish, raw: H.modelFinish },
        usage: {
          inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 900, text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error('the suggestion route does not stream');
    },
  })),
}));

import { log } from '../../lib/logger.js';
import { createSuggestion } from '../../db/notifications/suggestionRepository.js';
import router from '../suggestions.js';

/** The last middleware on the route is the handler; the first is the auth. */
function generateHandler() {
  const layer = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } }> })
    .stack.find((l) => l.route?.path === '/generate' && l.route.methods.post);
  if (!layer?.route) throw new Error('POST /generate is not mounted');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: unknown, res: unknown) => Promise<void>;
}

interface MockRes {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
}

function makeRes(): MockRes {
  const res = { statusCode: 200, body: undefined as unknown } as MockRes;
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

async function generate(body: Record<string, unknown> = { count: 8 }): Promise<MockRes> {
  const res = makeRes();
  await generateHandler()({ user: { id: 'user-1' }, body }, res);
  return res;
}

/** Every argument this route logged, as one string, for leak assertions. */
function loggedText(): string {
  const calls = [
    ...vi.mocked(log.general.error).mock.calls,
    ...vi.mocked(log.general.warn).mock.calls,
    ...vi.mocked(log.general.info).mock.calls,
  ];
  return JSON.stringify(calls);
}

beforeEach(() => {
  vi.clearAllMocks();
  H.kaanaAnswer = null;
  H.kaanaThrows = null;
  H.kaanaRequest = null;
  H.modelText = '';
  H.modelFinish = 'stop';
  H.modelCall = null;
  H.resolves = true;
});

describe('the answer the model is asked for', () => {
  it('gives the output budget room for a complete answer', async () => {
    H.kaanaAnswer = COMPLETE_ANSWER;
    await generate();

    // Above 2048 because 2048 is the measured value that could not hold one:
    // the fixture above cost 2560 output tokens to produce, 1883 of them
    // reasoning. A ceiling at or below the cost of the answer is the bug.
    expect(H.kaanaRequest?.maxOutputTokens).toBeGreaterThan(2048);
  });

  it('asks for the schema rather than asking for prose and checking afterwards', async () => {
    H.kaanaAnswer = COMPLETE_ANSWER;
    await generate();

    const format = H.kaanaRequest?.responseFormat as { type: string; name: string; schema: Record<string, unknown> };
    expect(format?.type).toBe('json_schema');
    expect(format?.name.length).toBeGreaterThan(0);
    // The schema is the one the answer is validated against, so it has to name
    // the key the answer is read from — a schema for a different shape would
    // pass a shallower assertion.
    expect(JSON.stringify(format?.schema)).toContain('suggestions');
  });

  it('asks the fallback for the same schema', async () => {
    // `generateObject` is the only AI SDK call that carries a response format,
    // which is why the fallback uses it rather than `generateText`.
    H.kaanaAnswer = null;
    H.modelText = COMPLETE_ANSWER;
    await generate();

    const format = H.modelCall?.responseFormat as { type: string; schema?: Record<string, unknown> };
    expect(format?.type).toBe('json');
    expect(JSON.stringify(format?.schema)).toContain('suggestions');
  });

  it('spends one deadline on every call rather than a fresh clock on each', async () => {
    // The client waits sixty seconds. Four independent thirty-second clocks add
    // up to a hundred and twenty, so the last two attempts were billed to
    // answer a client that had already gone.
    H.kaanaAnswer = null;
    H.modelText = COMPLETE_ANSWER;
    await generate();

    expect(H.kaanaRequest?.signal).toBeInstanceOf(AbortSignal);
    expect(H.modelCall?.abortSignal).toBe(H.kaanaRequest?.signal);
  });

  it('tells Kaana the same budget it holds the signal to', async () => {
    // Kaana enforces the envelope's budget at its end. A longer signal against
    // the old fixed thirty-second envelope would have been cancelled anyway, by
    // the other side.
    H.kaanaAnswer = COMPLETE_ANSWER;
    await generate();

    expect(H.kaanaRequest?.budgetMs).toBeGreaterThan(30_000);
  });

  it('asks for no more than a budget can hold, whatever the caller asked for', async () => {
    H.kaanaAnswer = COMPLETE_ANSWER;
    await generate({ count: 500 });

    expect(H.kaanaRequest?.prompt).toContain('Generate 10 unique');
  });

  it('survives a types field that is not a list', async () => {
    // `types.join(', ')` on a string reached the prompt builder and threw, so
    // this shape was a 500 before any model was asked.
    H.kaanaAnswer = COMPLETE_ANSWER;
    const res = await generate({ count: 8, types: 'welcome' });

    expect(res.statusCode).toBe(200);
    expect(H.kaanaRequest?.prompt).toContain('welcome, autocomplete');
  });
});

describe('a complete answer', () => {
  it('becomes suggestions', async () => {
    H.kaanaAnswer = COMPLETE_ANSWER;
    const res = await generate();

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ generated: 8 });
    expect(vi.mocked(createSuggestion)).toHaveBeenCalledTimes(8);
    expect(vi.mocked(createSuggestion).mock.calls[0][1]).toMatchObject({
      isAiGenerated: true,
      scope: 'personal',
      oxyUserId: 'user-1',
    });
  });

  it('becomes suggestions through the fallback too', async () => {
    H.kaanaAnswer = null;
    H.modelText = COMPLETE_ANSWER;
    const res = await generate();

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ generated: 8 });
  });
});

describe('an answer that was cut off', () => {
  it('is reported as a parse failure and creates nothing', async () => {
    H.kaanaAnswer = TRUNCATED_ANSWER;
    const res = await generate();

    expect(res.statusCode).toBe(500);
    expect(vi.mocked(createSuggestion)).not.toHaveBeenCalled();
    expect(vi.mocked(log.general.error)).toHaveBeenCalledWith(
      { responseChars: 3022 },
      'Failed to parse AI-generated suggestions',
    );
  });

  it('does not put the model output in the logs', async () => {
    // The leak #182 removed from this call site. It comes back the moment the
    // thrown value is logged under `err`, because pino copies an error's own
    // properties into the line and both the SDK's parse failure and a Zod error
    // carry what they were given.
    H.kaanaAnswer = TRUNCATED_ANSWER;
    await generate();

    expect(loggedText()).not.toContain(TRUNCATED_ANSWER.slice(100, 160));
    expect(loggedText()).not.toContain('Quick Idea Brainstorm');
  });

  it('says which fault it was, on the fallback path', async () => {
    // `length` is the fact nobody had: it says the answer was cut off at the
    // output budget rather than malformed, which is the difference between
    // raising a ceiling and rewriting a prompt.
    H.kaanaAnswer = null;
    H.modelText = TRUNCATED_ANSWER;
    H.modelFinish = 'length';
    const res = await generate();

    expect(res.statusCode).toBe(500);
    expect(vi.mocked(log.general.error)).toHaveBeenCalledWith(
      expect.objectContaining({ finishReason: 'length', responseChars: 3022 }),
      'Failed to parse AI-generated suggestions',
    );
    expect(loggedText()).not.toContain('Quick Idea Brainstorm');
  });

  it('is not reported as missing capacity', async () => {
    // 503 says "come back later"; a model that answered with something unusable
    // will answer the same way on the retry that advice invites.
    H.kaanaAnswer = null;
    H.modelText = TRUNCATED_ANSWER;
    H.modelFinish = 'length';
    const res = await generate();

    expect(res.body).toEqual({ error: 'Failed to generate suggestions' });
  });
});

describe('when nothing can answer', () => {
  it('reports missing capacity rather than a parse failure', async () => {
    H.kaanaAnswer = null;
    H.resolves = false;
    const res = await generate();

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'No AI models available' });
  });

  it('falls back when Kaana refuses the call, and logs the refusal under err', async () => {
    // A `KaanaInferenceError` carries a code and a request id and no content,
    // so this is the one failure whose thrown value belongs in the line.
    H.kaanaThrows = new Error('Kaana inference failed: cancelled');
    H.modelText = COMPLETE_ANSWER;
    const res = await generate();

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(log.general.warn)).toHaveBeenCalledWith(
      { err: H.kaanaThrows },
      'Kaana did not serve the suggestion prompt, falling back',
    );
  });
});
