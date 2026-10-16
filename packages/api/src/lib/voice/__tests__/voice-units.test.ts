import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => {
  const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: new Proxy({}, { get: () => quiet }) };
});

const { FakeKaanaError, FakeKaanaConnectionError } = await import('../../kaana/fake.js');
const { KAANA_PUBLIC_ERROR_CODES } = await import('../../kaana/port.js');
const { isModelRefusal, voiceFailureFromKaana, VOICE_ERROR_TEXT } = await import('../errors.js');
const {
  decodeAssistantAudioFrame,
  encodeAssistantAudioFrame,
  parseVoiceClientEvent,
  VOICE_SERVER_ERROR_CODES,
} = await import('../protocol.js');
const { runTool, toRealtimeTools } = await import('../tool-bridge.js');
const { composeVoiceInstructions, historyLines } = await import('../turn.js');
const { VoiceCreditMeter, BLOCK_MINUTES } = await import('../credits.js');
const { creditsForCost } = await import('../../credits-manager.js');
const { weatherTools } = await import('./support.js');

describe('every Kaana failure is a typed VoiceErrorCode (ADR 0017 §3 table)', () => {
  const expected: Record<string, string> = {
    invalid_request: 'realtime-rejected',
    authentication_failed: 'realtime-unavailable',
    permission_denied: 'realtime-rejected',
    insufficient_scope: 'realtime-rejected',
    model_not_found: 'realtime-unavailable',
    unsupported_modality: 'realtime-rejected',
    context_length_exceeded: 'realtime-rejected',
    request_too_large: 'realtime-rejected',
    output_limit_exceeded: 'realtime-rejected',
    idempotency_conflict: 'realtime-rejected',
    insufficient_balance: 'realtime-limited',
    spending_limit_exceeded: 'realtime-limited',
    quota_exceeded: 'realtime-limited',
    byok_credential_invalid: 'realtime-rejected',
    policy_violation: 'realtime-rejected',
    commercial_permission_denied: 'realtime-rejected',
    no_route_available: 'realtime-unavailable',
    upstream_content_filtered: 'realtime-rejected',
    cancelled: 'realtime-failed',
    rate_limited: 'realtime-limited',
    provider_error: 'realtime-failed',
    provider_timeout: 'realtime-failed',
    provider_overloaded: 'realtime-failed',
    service_unavailable: 'realtime-unavailable',
    internal_error: 'realtime-failed',
  };

  it.each(KAANA_PUBLIC_ERROR_CODES)('%s', (code) => {
    const failure = voiceFailureFromKaana(new FakeKaanaError(code));
    expect(failure.code).toBe(expected[code]);
    expect(VOICE_SERVER_ERROR_CODES).toContain(failure.code);
    // The person is told Alia's fixed sentence, never the upstream's words.
    expect(failure.message).toBe(VOICE_ERROR_TEXT[failure.code]);
  });

  it('a lost connection, a contract violation and anything unknown are realtime-failed', () => {
    expect(voiceFailureFromKaana(new FakeKaanaConnectionError()).code).toBe('realtime-failed');
    expect(
      voiceFailureFromKaana(Object.assign(new Error('x'), { name: 'KaanaProtocolError' })).code,
    ).toBe('realtime-failed');
    expect(voiceFailureFromKaana(new Error('boom')).code).toBe('realtime-failed');
  });

  it('moves to the next model only on the model’s own refusal before any output', () => {
    expect(isModelRefusal(new FakeKaanaError('model_not_found'))).toBe(true);
    expect(isModelRefusal(new FakeKaanaError('unsupported_modality'))).toBe(true);
    expect(isModelRefusal(new FakeKaanaError('invalid_request', { param: 'config.voice' }))).toBe(
      true,
    );
    expect(isModelRefusal(new FakeKaanaError('invalid_request', { param: 'limits' }))).toBe(false);
    expect(isModelRefusal(new FakeKaanaError('authentication_failed'))).toBe(false);
    expect(isModelRefusal(new FakeKaanaError('insufficient_balance'))).toBe(false);
    expect(isModelRefusal(new FakeKaanaError('rate_limited'))).toBe(false);
    expect(isModelRefusal(new FakeKaanaError('model_not_found', { afterOutput: true }))).toBe(
      false,
    );
  });
});

describe('the wire', () => {
  it('frames assistant audio with the item it belongs to', () => {
    const frame = encodeAssistantAudioFrame('item_ñ', new Uint8Array([1, 2, 3, 4]));
    expect(decodeAssistantAudioFrame(frame)).toEqual({
      itemId: 'item_ñ',
      pcm: new Uint8Array([1, 2, 3, 4]),
    });
    expect(() => encodeAssistantAudioFrame('', new Uint8Array(2))).toThrow();
  });

  it('parses only the events the protocol defines', () => {
    expect(
      parseVoiceClientEvent(
        '{"type":"session.start","protocol":2,"conversationId":"c-1","voice":"male","locale":"es-ES"}',
      ),
    ).toEqual({
      type: 'session.start',
      protocol: 2,
      conversationId: 'c-1',
      voice: 'male',
      locale: 'es-ES',
    });
    expect(
      parseVoiceClientEvent(
        '{"type":"session.start","protocol":2,"conversationId":"c 1","voice":"male","locale":"es"}',
      ),
    ).toBeNull();
    expect(
      parseVoiceClientEvent(
        '{"type":"session.start","protocol":2,"conversationId":"c1","voice":"alloy","locale":"es"}',
      ),
    ).toBeNull();
    expect(
      parseVoiceClientEvent('{"type":"playback.interrupted","itemId":"a1","playedMs":-1}'),
    ).toBeNull();
    expect(parseVoiceClientEvent('{"type":"tool.result","output":"x"}')).toBeNull();
    expect(parseVoiceClientEvent('not json')).toBeNull();
  });
});

describe('the tool bridge', () => {
  it('serializes schemas for the session and caps the set at 128', () => {
    const tools = weatherTools();
    expect(toRealtimeTools(tools, ['lookupWeather', 'missing'])).toEqual([
      expect.objectContaining({
        type: 'function',
        name: 'lookupWeather',
        description: 'The weather in a city',
        parameters: expect.objectContaining({ type: 'object' }),
      }),
    ]);
    const many = Object.fromEntries(
      Array.from({ length: 140 }, (_, index) => [`t${index}`, tools.lookupWeather!]),
    );
    expect(toRealtimeTools(many, Object.keys(many))).toHaveLength(128);
  });

  it('turns every failure into a typed tool error', async () => {
    const tools = weatherTools(async () => {
      throw new Error('upstream app down');
    });
    const unknown = await runTool(tools, 'nope', '{}', { toolCallId: 'a' });
    expect(JSON.parse(unknown.output).error.type).toBe('unknown_tool');
    const badJson = await runTool(tools, 'lookupWeather', '{city', { toolCallId: 'b' });
    expect(JSON.parse(badJson.output).error.type).toBe('invalid_arguments');
    const failed = await runTool(tools, 'lookupWeather', '{"city":"x"}', { toolCallId: 'c' });
    expect(failed.ok).toBe(false);
    expect(JSON.parse(failed.output).error).toEqual({
      type: 'tool_failed',
      message: 'upstream app down',
    });
  });
});

describe('the instructions fit the contract’s 32 768 characters', () => {
  const history = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `mensaje ${index} ${'x'.repeat(300)}`,
  }));

  it('carry the recent history and the session language', async () => {
    const text = await composeVoiceInstructions({
      base: async () => 'BASE',
      history: history.slice(-2),
      language: 'es-ES',
    });
    expect(text.startsWith('BASE')).toBe(true);
    expect(text).toContain('## The conversation so far');
    expect(text).toContain('Person: mensaje 38');
    expect(text).toContain('You: mensaje 39');
    expect(text).toContain('The person is speaking es-ES');
  });

  it('shrink the history first, then drop recalled memories, then refuse', async () => {
    const shrunk = await composeVoiceInstructions({
      base: async () => 'B'.repeat(30_000),
      history,
      language: 'es',
    });
    expect(shrunk.length).toBeLessThanOrEqual(32_768);
    expect(shrunk).toContain('mensaje 39');
    expect(shrunk).not.toContain('mensaje 0 ');

    const base = vi.fn(async (withRecalled: boolean) =>
      withRecalled ? 'M'.repeat(40_000) : 'BASE',
    );
    const withoutMemories = await composeVoiceInstructions({ base, history, language: 'es' });
    expect(withoutMemories.startsWith('BASE')).toBe(true);
    expect(base).toHaveBeenCalledWith(false);

    await expect(
      composeVoiceInstructions({ base: async () => 'B'.repeat(40_000), history, language: 'es' }),
    ).rejects.toMatchObject({ code: 'realtime-rejected' });
  });

  it('reads the newest messages, oldest first, within the budget', () => {
    const lines = historyLines(history, 700);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('mensaje 38');
  });
});

describe('credits are held in blocks and settled at the real cost', () => {
  function meter() {
    const blocks: Array<{ creditsReserved: number }> = [];
    const deps = {
      reserve: vi.fn(async (userId: string, credits: number) => {
        const block = {
          userId,
          creditsReserved: credits,
          initialFreeCredits: 0,
          initialPaidCredits: 0,
          grantKind: 'paid_balance' as const,
        };
        blocks.push(block);
        return block;
      }),
      finalize: vi.fn(async () => undefined),
      refund: vi.fn(async () => undefined),
    };
    return { meter: new VoiceCreditMeter('u', deps), deps, blocks };
  }

  it('reserves the next block a minute before the held one runs out', async () => {
    const { meter: m, deps } = meter();
    await m.open(0.1);
    expect(deps.reserve).toHaveBeenLastCalledWith('u', creditsForCost(0.1 * BLOCK_MINUTES));
    expect(await m.cover(0.3)).toBe(true);
    expect(deps.reserve).toHaveBeenCalledTimes(1);
    expect(await m.cover(0.41)).toBe(true);
    expect(deps.reserve).toHaveBeenCalledTimes(2);
  });

  it('charges earlier blocks whole and the last with the remainder; an unused block is refunded', async () => {
    const { meter: m, deps } = meter();
    await m.open(0.1);
    await m.cover(0.45);
    const total = await m.settle(0.6);
    const [first, second] = deps.finalize.mock.calls as unknown as Array<
      [{ creditsReserved: number }, number]
    >;
    expect(total).toBe(creditsForCost(0.6));
    expect(first![1]).toBe(first![0].creditsReserved);
    expect(second![1]).toBe(creditsForCost(0.6) - first![0].creditsReserved);

    const small = meter();
    await small.meter.open(0.1);
    await small.meter.cover(0.45);
    await small.meter.settle(0.01);
    expect(small.deps.finalize).toHaveBeenCalledTimes(1);
    expect(small.deps.refund).toHaveBeenCalledTimes(1);
  });
});
