import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The hook chain around one chat turn — epic #139 workstream 13, "Preserve
 * memory/context retrieval before inference" and "Preserve learning/context
 * updates after runs".
 *
 * ## The gap this closes, stated precisely
 *
 * `chatFlowFixtures.test.ts` already pins both halves AT THE ROUTE: recall runs
 * before the model call and its text reaches the prompt ("recall reaches the
 * model call, not merely precedes it"), and `hooks:afterChat` appears in every
 * transcript after the stream. Both of those mock `lib/hooks/index.js` wholesale.
 *
 * That leaves two ways the behaviour can stop happening with every existing test
 * still green:
 *
 *  1. **Registration.** The hooks are registered by SIDE-EFFECT IMPORTS in
 *     `lib/hooks/index.ts`. Delete one line and `runBeforeChatHooks` returns an
 *     empty result — no error, no failing test, no recalled memory in any
 *     prompt. This is the mechanism-green-and-inert shape: every hook file still
 *     compiles, still exports, still has tests, and none of them runs.
 *  2. **The autonomy half of the after-run path.** `runPostChatHooks` calls TWO
 *     things (`chat-lifecycle.ts:153,167`), and the fixtures' mock of
 *     `runAutonomyAfterChat` records nothing, so deleting that call changes no
 *     transcript.
 *
 * So this file mocks the STORES and runs the registry, the hook runner, all four
 * built-in hooks, the autonomy runtime and `runPostChatHooks` for real. What the
 * route does with them is the fixtures' job and is not repeated here.
 */

const H = vi.hoisted(() => {
  const timeline: string[] = [];
  const state = {
    recalled: [] as Array<{ title: string; summary: string; score: number }>,
    /** What `proactive-hook` is told the classifier said. */
    classification: '{"category":"none"}',
  };
  return { timeline, state };
});

// ── Stores and the model, mocked. Everything between them runs. ─────────────

vi.mock('../memory/recall.js', () => ({
  recallRelevantMemories: vi.fn(async (userId: string, query: string) => {
    H.timeline.push(`recall:memories(${userId},${query})`);
    return H.state.recalled;
  }),
}));

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('../../db/memory/userMemoryRepository.js', () => ({
  getOrCreateUserMemory: vi.fn(async () => ({ _id: 'mem-ws13', writingStyle: null })),
  setWritingStyle: vi.fn(async (_db: unknown, memoryId: string) => {
    H.timeline.push(`learn:writingStyle(${memoryId})`);
  }),
  findPreferredLanguage: vi.fn(async () => 'en-US'),
  findUserMemory: vi.fn(async () => null),
}));

vi.mock('../../db/usage/chatAnalyticsRepository.js', () => ({
  insertChatAnalytics: vi.fn(async (_db: unknown, row: Record<string, unknown>) => {
    H.timeline.push(`learn:analytics(${String(row.aliaModelId)},${String(row.totalTokens)})`);
  }),
}));

vi.mock('../../db/notifications/suggestionRepository.js', () => ({
  createSuggestion: vi.fn(async () => {
    H.timeline.push('learn:suggestion');
    return { id: 'sug-1' };
  }),
}));

vi.mock('../autonomy/context-graph.js', () => ({
  recallContextForIntent: vi.fn(async (params: { intent: string }) => {
    H.timeline.push(`recall:contextGraph(${params.intent})`);
    return { rankedSources: [{ sourceKey: 'inbox', score: 0.9 }], rules: [] };
  }),
  learnFromRun: vi.fn(async (params: { intent: string; success: boolean }) => {
    H.timeline.push(`learn:autonomy(${params.intent},${params.success})`);
  }),
  saveUserCorrection: vi.fn(async (params: { correctionText: string }) => {
    H.timeline.push(`learn:correction(${params.correctionText})`);
  }),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(async () => {
    H.timeline.push('proactive:classify');
    return { text: H.state.classification };
  }),
  stepCountIs: vi.fn(),
  tool: vi.fn(),
}));

vi.mock('../chat-core.js', () => ({
  resolveModel: vi.fn(async () => ({
    aliasModelId: 'alia-lite',
    provider: 'zzprovider',
    modelId: 'zz-lite',
    keyConfig: { provider: 'zzprovider', key: 'k', modelId: 'zz-lite' },
  })),
  getAIModel: vi.fn(() => ({})),
  getDefaultAliaModel: vi.fn(() => 'alia-lite'),
}));

// `chat-lifecycle.ts` pulls the whole post-turn surface in; only the two hook
// calls are under test here, so the rest is stubbed at its own module boundary.
vi.mock('../conversation-saver.js', () => ({
  saveConversation: vi.fn(async () => undefined),
  generateTitle: vi.fn(async () => null),
  generateConversationTitle: vi.fn(async () => null),
}));
vi.mock('../credits-manager.js', () => ({
  finalizeCredits: vi.fn(async () => ({ creditsCharged: 0, creditsRemaining: 0 })),
}));
vi.mock('../credit-anomaly.js', () => ({ detectCreditAnomaly: vi.fn(async () => null) }));
vi.mock('../gateway-client.js', () => ({ getAliaModel: vi.fn(async () => null) }));
vi.mock('../../middleware/api-key-rate-limit.js', () => ({ recordUsage: vi.fn(async () => undefined) }));
vi.mock('../notification-service.js', () => ({ sendNotification: vi.fn(async () => undefined) }));
vi.mock('../../models/conversation.js', () => ({
  Conversation: { findOne: vi.fn(() => ({ lean: async () => null })) },
}));

vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { chat: child, v1: child, general: child, agents: child, providers: child, codea: child } };
});

import { runAfterChatHooks, runBeforeChatHooks } from '../hooks/index.js';
import { runPostChatHooks, type LifecycleContext } from '../chat-lifecycle.js';
import { runAutonomyAfterChat, runAutonomyBeforeChat } from '../autonomy/runtime.js';

/**
 * Chosen so `classifyIntent` lands on `research` and nothing else: the rules are
 * ordered and `roadmap` matches `project_status` first (`autonomy/intents.ts:26`).
 */
const RESEARCH_ASK = 'investigate the benchmark numbers before we decide';

const MESSAGES = [
  { role: 'user', content: 'what did I decide about the roadmap last week' },
  { role: 'assistant', content: 'You decided to ship the canvas first.' },
  { role: 'user', content: 'remind me why we chose that ordering' },
];

function lifecycleContext(overrides: Partial<LifecycleContext> = {}): LifecycleContext {
  return {
    userId: 'user-ws13',
    conversationId: 'conv-ws13',
    messages: MESSAGES,
    aliasModelId: 'alia-v1',
    creditReservation: null,
    tokenUsage: { promptTokens: 40, completionTokens: 20, totalTokens: 60, systemPromptTokens: 10 },
    requestStartTime: Date.now() - 1_500,
    isApiKey: false,
    autonomyRuntime: null,
    ...overrides,
  } as LifecycleContext;
}

/** `runPostChatHooks` is fire-and-forget by design; drain what it spawned. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 8; j += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  H.timeline.length = 0;
  H.state.recalled = [{ title: 'Roadmap', summary: 'Canvas ships before console.', score: 0.8 }];
  H.state.classification = '{"category":"none"}';
  vi.clearAllMocks();
});

// ===========================================================================
// Before the run: the recall hooks are REGISTERED, not merely defined
// ===========================================================================

describe('memory recall happens because a hook is registered, not because a file exists', () => {
  it('returns the recalled memories the route puts in the prompt', async () => {
    const result = await runBeforeChatHooks({
      userId: 'user-ws13',
      conversationId: 'conv-ws13',
      messages: MESSAGES,
      model: 'alia-v1',
      platform: 'app',
      metadata: {},
    });

    // The query is the LAST user message, not the first and not the whole
    // transcript — recalling against the wrong turn is a silent quality
    // regression rather than an error.
    expect(H.timeline).toEqual(['recall:memories(user-ws13,remind me why we chose that ordering)']);
    expect(result.metadata).toEqual({
      recalledMemories: H.state.recalled,
      memoryRecallCount: 1,
    });
  });

  it('carries nothing when there is nothing to recall (the control)', async () => {
    // Without this, the assertion above would also pass for a hook that returned
    // a constant, and "recall works" would be a statement about the fixture.
    H.state.recalled = [];
    const result = await runBeforeChatHooks({
      userId: 'user-ws13',
      messages: MESSAGES,
      model: 'alia-v1',
      platform: 'app',
      metadata: {},
    });
    expect(H.timeline).toHaveLength(1);
    expect(result.metadata).toBeUndefined();
  });

  it('does not recall for an anonymous caller', async () => {
    const result = await runBeforeChatHooks({ messages: MESSAGES, platform: 'app', metadata: {} });
    expect(H.timeline).toEqual([]);
    expect(result.metadata).toBeUndefined();
  });

  it('recalls the autonomy context graph for the classified intent', async () => {
    // The second retrieval before inference, on its own entrypoint
    // (`request-context.ts:152`). It is a different mechanism from the hook
    // chain and fails independently of it.
    const runtime = await runAutonomyBeforeChat({
      userId: 'user-ws13',
      messages: [{ role: 'user', content: 'summarise my inbox' }],
    });

    expect(H.timeline).toEqual(['recall:contextGraph(inbox_digest)']);
    expect(runtime?.classification.intent).toBe('inbox_digest');
    expect(runtime?.recall.rankedSources).toEqual([{ sourceKey: 'inbox', score: 0.9 }]);
  });
});

// ===========================================================================
// After the run: both learning paths, from one entrypoint
// ===========================================================================

describe('the after-run entrypoint drives every learning path there is', () => {
  it('writes analytics, writing style and the autonomy run record', async () => {
    const runtime = await runAutonomyBeforeChat({
      userId: 'user-ws13',
      messages: [{ role: 'user', content: RESEARCH_ASK }],
    });
    H.timeline.length = 0;

    runPostChatHooks(lifecycleContext({ autonomyRuntime: runtime }), 'You decided to ship the canvas first.');
    await settle();

    // A floor first: an empty timeline is what a `runPostChatHooks` that
    // returned at the top produces AND what a broken recorder produces.
    expect(H.timeline.length).toBeGreaterThanOrEqual(3);
    // Sorted, because the hooks are fire-and-forget and their completion order
    // is not a property worth pinning — that they ALL ran is. The proactive
    // hook is excluded here because it is SAMPLED (below), and a sampled event
    // in an exact-equality assertion is a flake.
    expect(H.timeline.filter((entry) => entry.startsWith('learn:')).sort()).toEqual([
      'learn:analytics(alia-v1,60)',
      'learn:autonomy(research,true)',
      'learn:writingStyle(mem-ws13)',
    ]);
  });

  it('samples the proactive classifier at 20%, and the gate is real', async () => {
    // `proactive-hook.ts:89` is a cost control, and it is the reason the run
    // above cannot assert on this hook. Both sides are measured, because "it
    // never ran" and "it always runs" are both regressions.
    const random = vi.spyOn(Math, 'random');

    random.mockReturnValue(0.05);
    runPostChatHooks(lifecycleContext(), 'You decided to ship the canvas first.');
    await settle();
    expect(H.timeline).toContain('proactive:classify');

    H.timeline.length = 0;
    random.mockReturnValue(0.95);
    runPostChatHooks(lifecycleContext(), 'You decided to ship the canvas first.');
    await settle();
    expect(H.timeline).not.toContain('proactive:classify');
    // ...and the un-sampled hooks still ran, so the second half is a statement
    // about the gate rather than about the whole chain being skipped.
    expect(H.timeline).toContain('learn:analytics(alia-v1,60)');

    random.mockRestore();
  });

  it('records the run as unsuccessful when the model produced nothing', async () => {
    // The discriminator that makes `learn:autonomy(...,true)` above a
    // measurement rather than a constant.
    const runtime = await runAutonomyBeforeChat({
      userId: 'user-ws13',
      messages: [{ role: 'user', content: RESEARCH_ASK }],
    });
    H.timeline.length = 0;

    await runAutonomyAfterChat({
      userId: 'user-ws13',
      runtimeContext: runtime,
      messages: [{ role: 'user', content: RESEARCH_ASK }],
      assistantResponse: '',
      latencyMs: 10,
    });
    expect(H.timeline).toEqual(['learn:autonomy(research,false)']);
  });

  it('captures an explicit user correction as its own learning event', async () => {
    const runtime = await runAutonomyBeforeChat({
      userId: 'user-ws13',
      messages: [{ role: 'user', content: RESEARCH_ASK }],
    });
    H.timeline.length = 0;

    await runAutonomyAfterChat({
      userId: 'user-ws13',
      runtimeContext: runtime,
      messages: [{ role: 'user', content: 'Correction: the canvas ships second' }],
      assistantResponse: 'Noted.',
      latencyMs: 10,
    });

    // Order matters: the correction is stored BEFORE the run is scored, so a
    // failure scoring the run cannot lose what the user explicitly said.
    expect(H.timeline).toEqual([
      'learn:correction(the canvas ships second)',
      'learn:autonomy(research,true)',
    ]);
  });

  it('learns nothing about an anonymous turn', async () => {
    runPostChatHooks(lifecycleContext({ userId: undefined, autonomyRuntime: null }), 'answer');
    await settle();
    expect(H.timeline).toEqual([]);
  });

  it('a hook that throws does not stop the hooks after it', async () => {
    // Reachable in production: every one of these writes to a network store.
    // `hook-runner.ts:34,46` catches per hook precisely so one failing store
    // cannot silence the others — a property that is invisible until it matters.
    const { insertChatAnalytics } = await import('../../db/usage/chatAnalyticsRepository.js');
    vi.mocked(insertChatAnalytics).mockRejectedValueOnce(new Error('analytics store down'));

    await runAfterChatHooks({
      userId: 'user-ws13',
      messages: MESSAGES,
      model: 'alia-v1',
      platform: 'app',
      metadata: {},
      response: 'answer',
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      modelUsed: 'alia-v1',
      latencyMs: 5,
    });

    // The analytics hook has priority 100 and style-learning 200, so the
    // failure above is upstream of the survivor below.
    expect(H.timeline).toContain('learn:writingStyle(mem-ws13)');
  });
});
