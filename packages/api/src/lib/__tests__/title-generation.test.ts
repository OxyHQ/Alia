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
  /** What the title model returns. */
  titleText: 'Oat milk preferences',
}));

vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
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
  resolveModel: vi.fn(async (aliasModelId: string) => ({
    aliasModelId,
    provider: 'upstream',
    modelId: 'upstream-model',
    keyConfig: { provider: 'upstream', key: 'secret-not-for-clients', modelId: 'upstream-model' },
  })),
  getAIModel: vi.fn(() => ({ id: 'title-model' })),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
    H.titlePrompts.push(messages.find((m) => m.role === 'user')?.content ?? '');
    return { text: H.titleText };
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
  H.titleText = 'Oat milk preferences';
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
