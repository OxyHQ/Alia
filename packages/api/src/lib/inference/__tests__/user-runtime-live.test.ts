import { describe, expect, it, vi } from 'vitest';

/**
 * The whole server-side chain against a REAL local model.
 *
 * Opt-in, because it needs an OpenAI-compatible server listening on this
 * machine:
 *
 *   ALIA_LOCAL_RUNTIME_MODEL=gemma4:26b bun x vitest run src/lib/inference/__tests__/user-runtime-live.test.ts
 *
 * Skipped without that variable, so CI stays green — and skipped tests measure
 * nothing, which is why the unit suite beside this one covers the framing with
 * doubles. What THIS adds is the one thing a double cannot: that the bytes a
 * real runtime produces are bytes the AI SDK's own OpenAI parser accepts. The
 * design rests on that claim — the browser copies bytes it never parses — and
 * every mocked test in the repository would pass with the claim false.
 *
 * The fake socket below does exactly what `use-local-runtime.ts` does in the
 * browser: fetch the endpoint, emit head, stream chunks, emit end.
 */
const MODEL = process.env.ALIA_LOCAL_RUNTIME_MODEL;
const ENDPOINT = process.env.ALIA_LOCAL_RUNTIME_ENDPOINT ?? 'http://localhost:11434/v1';
const OWNER = 'live-user';
const RUNTIME_ID = 'live-runtime';

vi.mock('../../../socket.js', () => ({
  getIO: () => ({
    in: () => ({
      fetchSockets: async () => [
        { id: 'live-socket', data: { localRuntime: { id: RUNTIME_ID, label: 'This machine', models: [MODEL] } } },
      ],
    }),
    to: () => ({
      emit: (event: string, payload: { runId: string; path: string; method: string; body: string | null }) => {
        if (event !== 'user-runtime:request') return;
        void (async () => {
          const { deliverUserRuntimeMessage } = await import('../user-runtime-bridge.js');
          try {
            const response = await fetch(`${ENDPOINT}${payload.path.replace(/^\/v1/, '')}`, {
              method: payload.method,
              headers: { 'Content-Type': 'application/json' },
              body: payload.body ?? undefined,
            });
            deliverUserRuntimeMessage(OWNER, { runId: payload.runId, kind: 'head', status: response.status });
            const reader = response.body?.getReader();
            if (reader) {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) deliverUserRuntimeMessage(OWNER, { runId: payload.runId, kind: 'chunk', data: value });
              }
            }
            deliverUserRuntimeMessage(OWNER, { runId: payload.runId, kind: 'end' });
          } catch (error: unknown) {
            deliverUserRuntimeMessage(OWNER, {
              runId: payload.runId,
              kind: 'error',
              message: error instanceof Error ? error.message : 'failed',
            });
          }
        })();
      },
    }),
  }),
}));

vi.mock('../../redis.js', () => ({ getRedisClient: () => null }));

describe.skipIf(!MODEL)('a real local model answering through the bridge', () => {
  it('streams text the AI SDK parsed out of the runtime own bytes', async () => {
    const { streamText } = await import('ai');
    const { getAIModel } = await import('../../chat-core.js');
    const { USER_RUNTIME_PROVIDER } = await import('../user-runtime-bridge.js');

    const model = getAIModel(
      {
        routingProfileId: `local/${RUNTIME_ID}/${MODEL}`,
        provider: USER_RUNTIME_PROVIDER,
        publisher: 'unknown',
        model: String(MODEL),
        modelId: String(MODEL),
        // Null for the same reason the product sets it null: hosted Oxy
        // inference cannot reach a process on this machine.
        oxyInferenceTarget: null,
        keyConfig: {
          provider: USER_RUNTIME_PROVIDER,
          modelId: String(MODEL),
          userRuntime: { userId: OWNER, runtimeId: RUNTIME_ID },
        },
        routingProfile: {
          id: `local/${RUNTIME_ID}/${MODEL}`,
          name: String(MODEL),
          tier: 'local',
          description: 'Served by the user\u2019s own device.',
          creditMultiplier: 0,
          maxTokens: 0,
          supportsTools: true,
          supportsVision: false,
          category: 'local',
        },
        isFallback: false,
      },
      'chat',
    );

    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: BRIDGE OK' }],
      maxOutputTokens: 200,
    });

    /**
     * Read the FULL stream rather than `textStream`, and that is the lesson this
     * test was written by learning.
     *
     * Asserting on text alone failed against a real reasoning model: Ollama
     * emits a non-standard `reasoning` field inside the delta, and with a small
     * output budget the entire budget went to reasoning while `content` stayed
     * empty. Zero text, no error, transport perfect — which is precisely the
     * shape of "my assertion measured the model's verbosity, not the wire".
     *
     * What the design actually claims is that the SDK's own OpenAI parser
     * accepts bytes the browser copied without reading. A parsed part of ANY
     * kind is that claim; which kind is the model's business.
     */
    const kinds: string[] = [];
    for await (const part of result.fullStream) kinds.push(part.type);

    expect(kinds).toContain('start');
    expect(kinds.some((kind) => kind === 'text-delta' || kind === 'reasoning-delta')).toBe(true);
    // No error part: a stream that errors mid-flight still yields parts, so the
    // assertion above passes on a half-broken transport without this.
    expect(kinds).not.toContain('error');

    const usage = await result.usage;
    expect(usage.outputTokens ?? 0).toBeGreaterThan(0);
  }, 180_000);
});
