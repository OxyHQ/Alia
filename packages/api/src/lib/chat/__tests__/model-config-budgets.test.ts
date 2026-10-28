/**
 * What `buildBaseConfig` bills and how long it waits: the usage a turn is
 * charged on, and the three clocks (first byte, silence, whole response).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../chat-core.js', () => ({ getAIModel: vi.fn(() => 'model') }));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { v1: child, chat: child } };
});

const { buildBaseConfig, createStreamWatchdog, NON_STREAMING_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } =
  await import('../model-config.js');

function build(stream: boolean, extra: Record<string, unknown> = {}) {
  const onUsage = vi.fn();
  const built = buildBaseConfig({
    resolved: {
      provider: 'kaana',
      modelId: 'acme/chat-1',
      keyConfig: { modelId: 'acme/chat-1' },
    } as never,
    body: { stream },
    convertedMessages: [],
    truncatedTools: {},
    reasoningEffort: null,
    systemPromptTokens: 7,
    streamState: { hasStreamedContent: false },
    onUsage,
    ...extra,
  });
  return { ...built, onUsage };
}

describe('usage is the whole turn', () => {
  it('bills totalUsage, not the last step alone, with the reasoning breakdown of the total', async () => {
    const { config, onUsage } = build(true);

    await config.onFinish({
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      totalUsage: {
        inputTokens: 300,
        outputTokens: 120,
        totalTokens: 420,
        outputTokenDetails: { reasoningTokens: 80 },
      },
    });

    expect(onUsage).toHaveBeenLastCalledWith({
      promptTokens: 300,
      completionTokens: 120,
      totalTokens: 420,
      systemPromptTokens: 7,
      reasoningTokens: 80,
    });
  });

  it('adds a later pass (the synthesis) instead of replacing the turn with it', async () => {
    const { config, onUsage } = build(true);

    await config.onFinish({
      totalUsage: { inputTokens: 300, outputTokens: 100, totalTokens: 400 },
    });
    await config.onFinish({ totalUsage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 } });

    expect(onUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({ promptTokens: 340, completionTokens: 110, totalTokens: 450 }),
    );
  });
});

describe('the clocks', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('aborts a streaming attempt that says nothing for 20s', () => {
    const { config } = build(true);
    vi.advanceTimersByTime(20_001);
    expect(config.abortSignal.aborted).toBe(true);
  });

  it('does not hold a non-streaming call to the first-byte clock', () => {
    const { config } = build(false);
    vi.advanceTimersByTime(30_000);
    expect(config.abortSignal.aborted).toBe(false);
    vi.advanceTimersByTime(NON_STREAMING_TIMEOUT_MS);
    expect(config.abortSignal.aborted).toBe(true);
  });

  it('aborts through the controller the route owns', () => {
    const providerAbort = new AbortController();
    const { config } = build(true, { providerAbort });
    expect(config.abortSignal).toBe(providerAbort.signal);
    providerAbort.abort(new Error('Global request timeout after 80s'));
    expect(config.abortSignal.aborted).toBe(true);
  });
});

describe('the stream watchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('aborts a stream that goes quiet after it started', () => {
    const abort = vi.fn();
    const watchdog = createStreamWatchdog(abort);
    watchdog.touch();
    vi.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS - 1);
    expect(abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(abort.mock.calls[0][0].message).toMatch(/idle timeout/);
  });

  it('is pushed back by every chunk', () => {
    const abort = vi.fn();
    const watchdog = createStreamWatchdog(abort);
    for (let i = 0; i < 5; i++) {
      watchdog.touch();
      vi.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS - 1000);
    }
    expect(abort).not.toHaveBeenCalled();
  });

  it('does not count the time one of Alia’s own tools takes', () => {
    const abort = vi.fn();
    const watchdog = createStreamWatchdog(abort);
    watchdog.touch();
    watchdog.toolStarted();
    vi.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS * 3);
    expect(abort).not.toHaveBeenCalled();
    // The tool is back: the provider has until the window runs out again.
    watchdog.toolFinished();
    vi.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS + 1);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('stays quiet once stopped', () => {
    const abort = vi.fn();
    const watchdog = createStreamWatchdog(abort);
    watchdog.touch();
    watchdog.stop();
    watchdog.touch();
    vi.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS * 2);
    expect(abort).not.toHaveBeenCalled();
  });
});

describe('the step bound', () => {
  const stopsAt = (config: { stopWhen: Array<(state: { steps: unknown[] }) => boolean> }) =>
    [1, 2, 3, 4, 5, 15, 16].find((count) =>
      config.stopWhen[0]({ steps: Array.from({ length: count }, () => ({})) }),
    );

  it('ends an ordinary turn after five steps', () => {
    expect(stopsAt(build(true).config)).toBe(5);
  });

  it('gives a turn whose host awaits results sixteen', async () => {
    const { HOST_AGENT_TURN_STEP_BOUNDS } = await import('../model-config.js');
    expect(stopsAt(build(true, { stepBounds: HOST_AGENT_TURN_STEP_BOUNDS }).config)).toBe(16);
  });
});
