import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Conversation titles — epic #139 workstream 6, *"`/alia/chat` or its successor
 * remains responsible for … title generation"*.
 *
 * ## Why this is not covered by the flow fixtures
 *
 * `chatFlowFixtures.test.ts` pins `sse:event:alia.title` in the app transcript,
 * which proves the STREAMING path emits a title. It cannot say anything about
 * the three ways titling goes wrong in production, because it drives one turn of
 * one brand-new conversation:
 *
 *  - the NON-streaming path titles through a different function entirely
 *    (`generateTitleAsync` → `generateConversationTitle`), and nothing asserts
 *    the entrypoint still calls it;
 *  - both paths carry a "do not re-title" condition, and losing one silently
 *    overwrites the name a user chose — no error, no failed request, just a
 *    title that will not stay put;
 *  - the write is scoped to the owner, and a title is the one conversation field
 *    a background job writes without the request's own filter in hand.
 *
 * All three fail by producing a plausible result, which is why each is asserted
 * against the wrong answer and not merely for the right one.
 */

const H = vi.hoisted(() => ({
  /** What `findConversation` answers, per test. */
  conversation: null as { isManualTitle?: boolean } | null,
  /** What `countMessagesInConversation` answers, per test. */
  messageCount: 0,
  /** Whether a message row exists for the conversation (streaming path). */
  messageExists: false,
  /** Every `updateConversationTitle` call, with all three of its arguments. */
  updates: [] as Array<{ oxyUserId: string; conversationId: string; title: string }>,
  /** Every prompt handed to the title model. */
  titlePrompts: [] as string[],
  /** Every output-token budget the title model was given. */
  titleBudgets: [] as Array<number | undefined>,
  /** What the title model returns, once it gets as far as speaking. */
  titleText: 'Oat milk preferences',
  /**
   * How many tokens the model spends thinking before its first word.
   *
   * The default is one of three values measured against the deployment
   * `alia-lite` resolves to in production on 2026-08-25 (UTC) — 104, with 78 and 127
   * on the other two runs of the same prompt. It is a property of the model,
   * not of the prompt, and the caller cannot see it or turn it off.
   */
  reasoningTokens: 104,
  /** What `resolveModel` answers; `null` is "no provider key was available". */
  resolvesToModel: true,
  /** When set, `generateText` throws it. */
  modelThrows: null as Error | null,
  /** Everything the code under test logged, by level. */
  logs: [] as Array<{ level: string; fields: unknown; message: string }>,
}));

vi.mock('../logger.js', () => {
  const record = (level: string) =>
    vi.fn((fields: unknown, message?: string) => {
      H.logs.push(
        typeof fields === 'string'
          ? { level, fields: {}, message: fields }
          : { level, fields, message: message ?? '' },
      );
    });
  const child = { info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') };
  return { log: { agents: child, chat: child, general: child, v1: child, providers: child, codea: child } };
});

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../db/chat/conversationRepository.js', () => ({
  findConversation: vi.fn(async () => H.conversation ?? undefined),
  conversationExists: vi.fn(async () => H.conversation !== null),
  updateConversationTitle: vi.fn(async (_db: unknown, oxyUserId: string, conversationId: string, title: string) => {
    H.updates.push({ oxyUserId, conversationId, title });
    return H.conversation ? 1 : 0;
  }),
}));

vi.mock('../../db/chat/messageRepository.js', () => ({
  countMessagesInConversation: vi.fn(async () => H.messageCount),
  messageExistsInConversation: vi.fn(async () => H.messageExists),
}));

vi.mock('../chat-core.js', () => ({
  resolveModel: vi.fn(async (aliasModelId: string) =>
    H.resolvesToModel
      ? {
          aliasModelId,
          provider: 'upstream',
          modelId: 'upstream-model',
          keyConfig: { provider: 'upstream', key: 'secret-not-for-clients', modelId: 'upstream-model' },
        }
      : null,
  ),
  getAIModel: vi.fn(() => ({ id: 'title-model' })),
}));

/**
 * A model that thinks before it speaks, which is what the title call actually
 * talks to.
 *
 * The previous fixture returned `{ text: H.titleText }` for any budget at all,
 * so it agreed with a caller asking for thirty tokens and a caller asking for
 * five hundred. Production does not: the answer arrives `finishReason:
 * 'length'` with the whole budget spent on reasoning and NOTHING in `text`, and
 * that is a success as far as every layer above it can tell. A fixture that
 * cannot produce that outcome cannot catch the bug that produces it.
 */
vi.mock('ai', () => ({
  generateText: vi.fn(async (
    { messages, maxOutputTokens }: { messages: Array<{ role: string; content: string }>; maxOutputTokens?: number },
  ) => {
    H.titlePrompts.push(messages.find((m) => m.role === 'user')?.content ?? '');
    H.titleBudgets.push(maxOutputTokens);
    if (H.modelThrows) throw H.modelThrows;
    const budget = maxOutputTokens ?? Number.MAX_SAFE_INTEGER;
    if (budget <= H.reasoningTokens) {
      return {
        text: '',
        finishReason: 'length',
        usage: { outputTokens: budget, reasoningTokens: budget - 2, inputTokens: 117 },
      };
    }
    return {
      text: H.titleText,
      finishReason: 'stop',
      usage: { outputTokens: H.reasoningTokens + 15, reasoningTokens: H.reasoningTokens, inputTokens: 117 },
    };
  }),
}));

import { findConversation } from '../../db/chat/conversationRepository.js';
import { generateConversationTitle, generateTitle } from '../conversation-saver.js';
import { generateTitleAsync, startParallelTitleGeneration } from '../chat-lifecycle.js';
import type { ChatMessage } from '../message-converter.js';

const API_SRC = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Source with comments stripped, so a census cannot read this repo's prose. */
function code(relative: string): string {
  const text = readFileSync(path.join(API_SRC, relative), 'utf8');
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  const ranges: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    for (const comment of [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ]) {
      ranges.push([comment.pos, comment.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let out = text;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
  }
  return out;
}

const USER_TURN: ChatMessage[] = [
  { role: 'system', content: 'you are alia' },
  { role: 'user', content: 'what do I take in my coffee' },
];

beforeEach(() => {
  H.conversation = null;
  H.messageCount = 0;
  H.messageExists = false;
  H.updates.length = 0;
  H.titlePrompts.length = 0;
  H.titleBudgets.length = 0;
  H.titleText = 'Oat milk preferences';
  H.reasoningTokens = 104;
  H.resolvesToModel = true;
  H.modelThrows = null;
  H.logs.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  The model call itself                                                      */
/* -------------------------------------------------------------------------- */

describe('a title is generated from the first user message (#139 ws6)', () => {
  it('asks the cheapest tier, on the user message, and cleans the answer', async () => {
    H.titleText = '  "Oat milk preferences."  ';
    const title = await generateTitle('what do I take in my coffee');

    expect(title).toBe('Oat milk preferences');
    // The cheap tier is the point: titling every new conversation on the same
    // model that answers it would double the cost of a first turn.
    const { resolveModel } = await import('../chat-core.js');
    expect(vi.mocked(resolveModel).mock.calls[0]?.[0]).toBe('alia-lite');
    expect(H.titlePrompts).toEqual(['what do I take in my coffee']);
  });

  it('returns null rather than a junk title when the model answers badly', async () => {
    // The caller writes whatever it is handed, so the refusal has to live here.
    // An empty answer and a runaway answer both used to become a title.
    H.titleText = '   ';
    expect(await generateTitle('hi')).toBeNull();

    H.titleText = 'x'.repeat(120);
    expect(await generateTitle('hi')).toBeNull();

    // The control: a well-formed answer still comes back, so the two nulls are
    // about the guard and not about a mock that never returns anything.
    H.titleText = 'A normal title';
    expect(await generateTitle('hi')).toBe('A normal title');
  });
});

describe('the title budget covers the model\'s reasoning, not just the title', () => {
  it('still gets a title out of a model that spends a hundred tokens thinking first', async () => {
    // The production failure, reproduced. `maxOutputTokens: 30` was budgeted
    // from the length of a title — six words, ~15 tokens, doubled for safety —
    // and MEASURED against the real deployment on 2026-08-25 (UTC) it returned
    // `finishReason: 'length'`, 28 of 30 tokens spent on reasoning, `text: ''`.
    // `generateTitle` then returned null on its last line, silently, for every
    // conversation.
    //
    // Asserted as a property of the OUTCOME and not as `toBe(512)`: the number
    // is not the contract, "enough to outlast a preamble nobody controls" is.
    H.reasoningTokens = 104;

    expect(await generateTitle('what do I take in my coffee')).toBe('Oat milk preferences');
    const [budget] = H.titleBudgets;
    expect(budget).toBeGreaterThan(H.reasoningTokens);
  });

  it('and the control: the same call at the old budget produces nothing', async () => {
    // What this test would report if the thing it measures were absent. Without
    // it, the fixture agrees with any budget at all and the case above passes
    // on `30` — which is exactly how the suite stayed green while no
    // conversation in production got a title.
    const { generateText } = await import('ai');
    const result = await vi.mocked(generateText).getMockImplementation()!({
      model: { id: 'title-model' },
      messages: [{ role: 'user', content: 'what do I take in my coffee' }],
      maxOutputTokens: 30,
    } as never);

    expect(result.text).toBe('');
    expect(result.finishReason).toBe('length');
  });

  it('survives a model that thinks for longer than the largest run measured', async () => {
    // 127 was the longest of the three production runs. The budget has room for
    // a model slower to get to the point than any of them.
    H.reasoningTokens = 300;
    expect(await generateTitle('what do I take in my coffee')).toBe('Oat milk preferences');
  });
});

/* -------------------------------------------------------------------------- */
/*  A title that does not arrive says why                                      */
/* -------------------------------------------------------------------------- */

describe('no title is never silent (operator logs, never the response body)', () => {
  /** The messages logged at or above `warn`, which is where a fault belongs. */
  const faults = (): string[] =>
    H.logs.filter((entry) => entry.level === 'warn' || entry.level === 'error').map((entry) => entry.message);

  it('says so when the model answered and produced nothing usable', async () => {
    // THE path that was firing in production, and the only one of the three
    // with no log at all: the call succeeds, `result.text` is empty, and the
    // last line returns null through a ternary.
    H.reasoningTokens = 1000;

    expect(await generateTitle('what do I take in my coffee')).toBeNull();
    expect(faults()).toEqual(['Title generation produced no usable title']);

    // The reason, not just the fact. An operator reading `finishReason:
    // 'length'` beside a reasoning-token count is looking at the budget; the
    // same line without them is looking at nothing.
    const [fault] = H.logs.filter((entry) => entry.level === 'warn');
    expect(fault.fields).toMatchObject({
      provider: 'upstream',
      modelId: 'upstream-model',
      finishReason: 'length',
      reasoningTokens: expect.any(Number),
    });
  });

  it('says so when no provider key could serve the cheap tier', async () => {
    H.resolvesToModel = false;

    expect(await generateTitle('what do I take in my coffee')).toBeNull();
    expect(faults()).toEqual(['Title generation skipped: no model available']);
    // And it never reached the model, so this is the resolver and not the call.
    expect(H.titlePrompts).toEqual([]);
  });

  it('says so when the call throws, including from the resolver', async () => {
    H.modelThrows = new Error('upstream refused the request');

    expect(await generateTitle('what do I take in my coffee')).toBeNull();
    expect(faults()).toEqual(['Title generation failed']);

    // `resolveModel` throws for an unregistered identifier and for a policy that
    // forbids fallback. Neither is reachable for `alia-lite` today — it is
    // registered and its preset is `cross-model` — but the call used to sit
    // OUTSIDE the try, so the day a preset narrows, the throw leaves this
    // function and lands in `provider-loop`'s catch, the one place that cannot
    // name it. Asserted at the source because the reachable inputs cannot
    // produce it.
    const saver = code('lib/conversation-saver.ts');
    expect(saver).toMatch(/try \{\s*const resolved = await resolveModel\('alia-lite'\);/);
  });

  it('the provider loop logs what it catches instead of discarding it', () => {
    // `.catch(() => null)` on the streaming path swallowed everything
    // `startParallelTitleGeneration` could throw — both existence queries — so
    // titling could stop entirely against a sick database with nothing to read.
    const loop = code('lib/chat/provider-loop.ts');
    expect(loop).not.toMatch(/startParallelTitleGeneration\([^)]*\)\.catch\(\(\) => null\)/);
    expect(loop).toMatch(/\.catch\(\(err: unknown\) => \{\s*log\.v1\.error\(\{ err, conversationId \}/);
  });

  it('and none of it reaches the client, which is simply told nothing', async () => {
    // The product rule: route detail is an operator fact. A title that fails is
    // an absent `alia.title` event, never an error frame — the SSE write is
    // inside `if (title)`.
    H.reasoningTokens = 1000;
    expect(await generateTitle('what do I take in my coffee')).toBeNull();

    const loop = code('lib/chat/provider-loop.ts');
    expect(loop).toMatch(/if \(title\) \{\s*res\.write\(`event: alia\.title/);
  });
});

/* -------------------------------------------------------------------------- */
/*  Streaming path: startParallelTitleGeneration                               */
/* -------------------------------------------------------------------------- */

describe('the streaming path titles a new conversation only (#139 ws6)', () => {
  it('titles a conversation that has no stored rows yet', async () => {
    // A conversation row created by `POST /conversations/new` with no messages
    // is still "new" — the row exists before the first turn arrives, so
    // existence alone cannot be the test.
    H.conversation = {};
    H.messageExists = false;

    expect(await startParallelTitleGeneration('user-ws6', 'conv-1', USER_TURN)).toBe('Oat milk preferences');
    expect(H.titlePrompts).toEqual(['what do I take in my coffee']);
  });

  it('refuses to re-title a conversation that already has messages', async () => {
    // The property that protects a renamed conversation on the streaming path.
    // Losing it costs no error and no failed request: every turn would generate
    // a fresh title and `provider-loop.ts` would write it over the user's.
    H.conversation = {};
    H.messageExists = true;

    expect(await startParallelTitleGeneration('user-ws6', 'conv-1', USER_TURN)).toBeNull();
    // Asserted at the MODEL, not only at the return value: a version that
    // generated and then discarded would still bill the user for the call.
    expect(H.titlePrompts).toEqual([]);
  });

  it('reads the first user message out of a multi-part content array', async () => {
    // The app sends attachments as content parts, so `content` is not always a
    // string. A version that only handled strings returns null here — no title
    // on precisely the conversations that opened with an image.
    H.conversation = null;
    const parts: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
          { type: 'text', text: 'what is in this picture' },
        ],
      } as unknown as ChatMessage,
    ];

    expect(await startParallelTitleGeneration('user-ws6', 'conv-1', parts)).toBe('Oat milk preferences');
    expect(H.titlePrompts).toEqual(['what is in this picture']);
  });

  it('the streaming entrypoint still starts it and still persists the result', () => {
    // The "green and inert" half. Everything above would keep passing with the
    // call deleted from the provider loop, and the fixtures' `alia.title` frame
    // proves the EVENT is written, not that the title reaches storage — a client
    // that reconnects reads the row, not the stream it already missed.
    const loop = code('lib/chat/provider-loop.ts');
    expect(loop).toContain('export async function runProviderLoop');
    expect(loop).toMatch(/titlePromise = startParallelTitleGeneration\(req\.user\.id, conversationId, messages\)/);
    expect(loop).toMatch(/res\.write\(`event: alia\.title/);
    expect(loop).toMatch(
      /await updateConversationTitle\(getDb\(\), req\.user\.id, conversationId, title\);/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Non-streaming path: generateConversationTitle                              */
/* -------------------------------------------------------------------------- */

describe('the non-streaming path titles without clobbering (#139 ws6)', () => {
  it('writes the title scoped to the owner', async () => {
    H.conversation = { isManualTitle: false };
    H.messageCount = 2;

    await generateConversationTitle('user-ws6', 'conv-1', 'what do I take in my coffee');

    // Both halves of the key. `conversationId` alone is not an owner check: the
    // id is a client-supplied string and the unique index is on the PAIR
    // (`db/__tests__/chat.pgdb.test.ts`, "two people can hold seq 0 in the same
    // conversation id"), so a call missing `oxyUserId` can title a stranger's
    // conversation. `chatRepositories.pgdb.test.ts` proves the repository really
    // scopes on both; this asserts the caller passes both.
    expect(H.updates).toEqual([
      { oxyUserId: 'user-ws6', conversationId: 'conv-1', title: 'Oat milk preferences' },
    ]);
  });

  it('leaves a manually titled conversation alone', async () => {
    H.conversation = { isManualTitle: true };
    H.messageCount = 1;

    await generateConversationTitle('user-ws6', 'conv-1', 'what do I take in my coffee');

    expect(H.updates).toEqual([]);
    expect(H.titlePrompts).toEqual([]);
  });

  it('stops titling once the conversation is past its opening turns', async () => {
    H.conversation = { isManualTitle: false };
    H.messageCount = 4;

    await generateConversationTitle('user-ws6', 'conv-1', 'a much later message');

    expect(H.updates).toEqual([]);
    expect(H.titlePrompts).toEqual([]);
  });

  it('does nothing when the conversation is not there', async () => {
    // Not an error path for the caller: this runs fire-and-forget after the
    // response was already sent, so the only correct behaviour is silence.
    H.conversation = null;
    await expect(generateConversationTitle('user-ws6', 'gone', 'hello')).resolves.toBeUndefined();
    expect(H.updates).toEqual([]);
  });

  it('generateTitleAsync forwards the first user message and swallows failures', async () => {
    H.conversation = { isManualTitle: false };
    H.messageCount = 0;

    generateTitleAsync('user-ws6', 'conv-1', USER_TURN);
    await new Promise((resolve) => { setImmediate(resolve); });

    // The system message must not become the title, which is what a naive
    // `messages[0]` would do — the route replaces `messages[0]` with the whole
    // assembled system prompt before this point (`chat-completions.ts:205-212`).
    expect(H.titlePrompts).toEqual(['what do I take in my coffee']);
    expect(H.updates).toHaveLength(1);

    // And a rejection does not become an unhandled rejection, because nothing
    // awaits this call.
    vi.mocked(findConversation).mockImplementationOnce(() => {
      throw new Error('database down');
    });
    expect(() => generateTitleAsync('user-ws6', 'conv-2', USER_TURN)).not.toThrow();
  });

  it('the non-streaming entrypoint still calls it', () => {
    // The other "green and inert" half, and the one with no fixture at all:
    // `chatFlowFixtures.test.ts`'s non-streaming flows are Codea and Cowork,
    // which send no `conversationId`, so nothing in the suite reaches this call.
    const nonStreaming = code('lib/chat/non-streaming.ts');
    expect(nonStreaming).toContain('export async function runNonStreaming');
    expect(nonStreaming).toMatch(
      /if \(conversationId && req\.user\?\.id && assistantResponse\) \{\s*generateTitleAsync\(req\.user\.id, conversationId, messages\);/,
    );

    // The floor: this file really is the branch the provider loop takes for a
    // non-streaming request.
    const loop = code('lib/chat/provider-loop.ts');
    expect(loop).toMatch(/if \(body\.stream !== true\) \{\s*await runNonStreaming\(\{/);
  });
});
