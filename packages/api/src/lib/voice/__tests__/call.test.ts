import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => {
  const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: new Proxy({}, { get: () => quiet }) };
});

const { creditsForCost } = await import('../../credits-manager.js');
const { KaanaBillingError, KaanaError } = await import('@kaana.ai/sdk');
const { decodeAssistantAudioFrame } = await import('../protocol.js');
const { harness, START, until, pcmBase64, weatherTools, REALTIME, catalogueModel, realtimeModel } =
  await import('./support.js');

/**
 * A voice call end to end against `@kaana.ai/sdk/testing`, the real client
 * against Kaana's own rules and catalogue in memory (ADR 0017 §3): opening in
 * the ADR's order, tools run in Alia, barge-in truncated at what was heard,
 * transcripts persisted as messages, limits, credits per minute and typed
 * failures.
 */

async function opened(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  await h.call.open(START);
  await until('session.ready', () => h.sink.types().includes('session.ready'));
  return h;
}

/** The client-visible wire, as one string: what the device could ever see. */
function wire(h: ReturnType<typeof harness>): string {
  return JSON.stringify(h.sink.events);
}

/** The catalogue's first voice of a gender on a model. */
function voiceOf(model: typeof REALTIME, gender: 'female' | 'male'): string {
  return model.audio!.voices.find((voice) => voice.gender === gender)!.id;
}

describe('opening', () => {
  it('correlates each actual upstream once without logging identity, instructions or audio', async () => {
    const { log } = await import('../../logger.js');
    const info = vi.mocked(log.voice.info);
    info.mockClear();
    const h = await opened();
    try {
      const first = h.session();
      const correlation = () =>
        info.mock.calls.filter(([, message]) => message === 'Voice upstream session created');
      expect(correlation()).toEqual([
        [
          { callId: h.call.callId, kaanaRequestId: first.requestId },
          'Voice upstream session created',
        ],
      ]);
      first.emit({
        type: 'session.created',
        model: `${first.model.modelId}@${first.model.currentRevision}`,
        kind: first.open.kind,
        config: first.open.config,
        limits: {
          maxDurationMs: 60_000,
          idleTimeoutMs: 30_000,
          maxResponses: 10,
          maxInputAudioBytes: 1_000_000,
          maxOutputAudioBytes: 1_000_000,
        },
        resumeWindowMs: 30_000,
        startedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await until('duplicate created delivered', () => h.sink.find('session.ready').length === 2);
      expect(correlation()).toHaveLength(1);
      first.emit({
        type: 'session.closed',
        reason: 'server_shutdown',
        units: [],
        usageSource: 'provider_reported',
        closedAt: new Date().toISOString(),
      });
      await until('replacement upstream correlated', () => correlation().length === 2);
      expect(correlation()[1]).toEqual([
        { callId: h.call.callId, kaanaRequestId: h.server.sessions[1]?.requestId },
        'Voice upstream session created',
      ]);
      expect(h.server.sessions).toHaveLength(2);
      expect(h.server.sessions[1]?.requestId).not.toBe(first.requestId);
    } finally {
      await h.call.end('hangup');
    }
  });

  it('opens a conversation with server VAD, barge-in, input transcription in the locale and the computed voice', async () => {
    const h = await opened();
    const session = h.session();
    expect(session.model.modelId).toBe(REALTIME.modelId);
    const { open } = session;
    expect(open.kind).toBe('conversation');
    // Barge-in is the session's; the silence that ends a turn is Kaana's default.
    expect(open.config.turnDetection).toEqual({
      type: 'server_vad',
      createResponse: true,
      interruptResponse: true,
    });
    // The person's locale as it is: Kaana gives every model the language.
    expect(open.config.inputAudioTranscription).toEqual({ language: 'es-ES' });
    expect(open.config.voice).toBe(voiceOf(REALTIME, 'female'));
    expect(open.config.inputAudioFormat).toBe('pcm16_24khz');
    expect(open.config.outputAudioFormat).toBe('pcm16_24khz');
    expect(open.config.instructions).toBe('INSTRUCTIONS(0)');
    expect(open.config.tools?.map((tool) => tool.name)).toEqual(['lookupWeather']);
    expect(open.config.tools?.[0]?.parameters).toMatchObject({
      type: 'object',
      properties: { city: { type: 'string' } },
    });
    // Auto is the contract's default: never sent.
    expect(open.config).not.toHaveProperty('toolChoice');
    expect(open.limits).toMatchObject({
      maxDurationMs: 30 * 60_000,
      idleTimeoutMs: 2 * 60_000,
      maxResponses: 500,
    });
    // The catalogue was read for the person, under Alia's service token.
    const list = h.server.requests.find(
      (request) => request.method === 'GET' && request.path.endsWith('/models'),
    );
    expect(list?.headers.get('X-Oxy-User-Id')).toBe('user-1');
    expect(h.sink.types().slice(0, 2)).toEqual(['session.accepted', 'session.ready']);
    const ready = h.sink.find('session.ready')[0]!;
    expect(ready.model.id).toBe(`${REALTIME.modelId}@${REALTIME.currentRevision}`);
    // The device never sees the instructions, a schema or the upstream voice id.
    expect(wire(h)).not.toContain('INSTRUCTIONS');
    expect(wire(h)).not.toContain('properties');
    expect(wire(h)).not.toContain(voiceOf(REALTIME, 'female'));
    // The one-call rule ran, and the first credit block is held.
    expect(h.startCall).toHaveBeenCalledOnce();
    expect(h.reserve).toHaveBeenCalledOnce();
    await h.call.end('hangup');
  });

  it('forwards audio only into a created session, acknowledging the first frame once', async () => {
    const h = harness();
    // Before there is a session, a frame goes nowhere.
    h.call.onClientAudio(new Uint8Array(1920));
    await h.call.open(START);
    await until('session.ready', () => h.sink.types().includes('session.ready'));
    h.call.onClientAudio(new Uint8Array(1920));
    h.call.onClientAudio(new Uint8Array(1920));
    await until('appended', () => h.commands('input_audio.append').length === 2);
    expect(h.sink.find('input.ready')).toHaveLength(1);
    // A frame over the contract's bound is not forwarded.
    h.call.onClientAudio(new Uint8Array(49_153));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.commands('input_audio.append')).toHaveLength(2);
    await h.call.end('hangup');
  });

  it('refuses a person without voice-mode on the server, before anything is reserved or dialled', async () => {
    const h = harness({ voiceMode: false });
    await h.call.open(START);
    expect(h.sink.find('error')[0]?.code).toBe('plan-required');
    expect(h.sink.find('session.closed')[0]?.reason).toBe('error');
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.startCall).not.toHaveBeenCalled();
    expect(h.server.sessions).toHaveLength(0);
    expect(h.sink.closed).toBe(true);
  });

  it('never tells a person to pay when their plan could not be read: a retryable unavailable', async () => {
    const h = harness({ entitlementsUnavailable: true });
    await h.call.open(START);
    expect(h.sink.find('error')[0]).toMatchObject({
      code: 'realtime-unavailable',
      retryable: true,
    });
    expect(h.sink.find('error').map((event) => event.code)).not.toContain('plan-required');
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.server.sessions).toHaveLength(0);
  });

  it('refuses when the credits do not cover the first block, without taking over another call', async () => {
    const h = harness({ reserve: async () => null });
    await h.call.open(START);
    expect(h.sink.find('error')[0]?.code).toBe('credits-exhausted');
    expect(h.startCall).not.toHaveBeenCalled();
    expect(h.server.sessions).toHaveLength(0);
  });

  it('refuses an agent it cannot reach as agent-unavailable', async () => {
    const missing = harness({ turnAgent: { kind: 'unavailable', reason: 'not_found' } });
    await missing.call.open({ ...START, agentId: 'agent-1' });
    expect(missing.sink.find('error')[0]?.code).toBe('agent-unavailable');
    expect(missing.server.sessions).toHaveLength(0);
  });

  it('is realtime-unavailable without a Kaana client, or with no model that can hold the call', async () => {
    const none = harness({ noKaana: true });
    await none.call.open(START);
    expect(none.sink.find('error')[0]?.code).toBe('realtime-unavailable');

    const noRealtime = harness({ models: [catalogueModel('x-ai/grok-voice-transcribe-2.0')] });
    await noRealtime.call.open(START);
    expect(noRealtime.sink.find('error')[0]?.code).toBe('realtime-unavailable');
    expect(noRealtime.reserve).not.toHaveBeenCalled();
  });

  it('opens on the cheapest minute, and tries the next candidate only when the model itself refused', async () => {
    const cheap = realtimeModel('x-ai/voice-cheap', '0.01');
    const dear = realtimeModel('x-ai/voice-dear', '0.5');
    const tried: string[] = [];
    // Kaana answering the cheapest model with its own refusal of the model.
    const refusing =
      (refusal: () => Error) => (kaana: import('../../kaana/port.js').KaanaClient) => ({
        ...kaana,
        realtime: {
          connect: (async (request, options) => {
            tried.push(request.model);
            if (request.model === cheap.modelId) throw refusal();
            return kaana.realtime.connect(request, options);
          }) as typeof kaana.realtime.connect,
        },
      });
    const modelGone = () =>
      new KaanaError({
        code: 'model_not_found',
        message: 'gone',
        status: 404,
        requestId: 'req_1',
        retryable: false,
      });
    const h = await opened({ models: [dear, cheap], wrapKaana: refusing(modelGone) });
    expect(tried).toEqual([cheap.modelId, dear.modelId]);
    expect(h.session().model.modelId).toBe(dear.modelId);
    await h.call.end('hangup');

    tried.length = 0;
    const billing = () =>
      new KaanaBillingError({
        code: 'insufficient_balance',
        message: 'no balance',
        status: 402,
        requestId: 'req_2',
        retryable: false,
      });
    const refused = harness({ models: [dear, cheap], wrapKaana: refusing(billing) });
    await refused.call.open(START);
    expect(tried).toEqual([cheap.modelId]);
    expect(refused.sink.find('error')[0]?.code).toBe('realtime-limited');
    // Nothing was served: every credit held is given back.
    expect(refused.refund).toHaveBeenCalledOnce();
    expect(refused.finalize).not.toHaveBeenCalled();
  });
});

describe('hanging up while the call opens', () => {
  it('ends the row written meanwhile and gives back a block held meanwhile', async () => {
    let releaseStart: () => void = () => undefined;
    const h = harness();
    h.startCall.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStart = () => resolve({ replaced: 0 });
        }),
    );
    const opening = h.call.open(START);
    await until('startCall', () => h.startCall.mock.calls.length === 1);
    await h.call.end('hangup');
    releaseStart();
    await opening;
    expect(h.finishCall).toHaveBeenCalledWith(h.call.callId, 'hangup');
    expect(h.server.sessions).toHaveLength(0);
    expect(h.refund).toHaveBeenCalledOnce();

    let releaseReserve: () => void = () => undefined;
    const slow = harness({
      reserve: (userId, credits) =>
        new Promise((resolve) => {
          releaseReserve = () =>
            resolve({
              userId,
              creditsReserved: credits,
              initialFreeCredits: 0,
              initialPaidCredits: 0,
              grantKind: 'paid_balance',
            });
        }),
    });
    const slowOpening = slow.call.open(START);
    await until('reserve', () => slow.reserve.mock.calls.length === 1);
    await slow.call.end('hangup');
    releaseReserve();
    await slowOpening;
    expect(slow.refund).toHaveBeenCalledOnce();
    expect(slow.startCall).not.toHaveBeenCalled();
  });
});

describe('tools run in Alia, never on the device', () => {
  it('executes the call, answers the model and continues the response; the client sees only the name', async () => {
    const execute = vi.fn(async ({ city }: { city: string }) => ({ city, celsius: 19 }));
    const h = await opened({ tools: weatherTools(execute) });
    const session = h.session();
    session.emit({ type: 'response.created', responseId: 'r1' });
    session.emit({
      type: 'tool_call',
      responseId: 'r1',
      itemId: 'fc1',
      toolCallId: 'call-1',
      name: 'lookupWeather',
      argumentsDelta: '{"city":',
      complete: false,
    });
    session.emit({
      type: 'tool_call',
      responseId: 'r1',
      itemId: 'fc1',
      toolCallId: 'call-1',
      argumentsDelta: '"Madrid"}',
      complete: true,
    });
    session.emit({
      type: 'response.done',
      responseId: 'r1',
      status: 'completed',
      units: [],
      usageSource: 'provider_reported',
    });
    await until('response.create', () => h.commands('response.create').length === 1);
    expect(execute).toHaveBeenCalledWith(
      { city: 'Madrid' },
      expect.objectContaining({ toolCallId: 'call-1' }),
    );
    const output = h.commands('conversation.item.create')[0]!;
    expect(output.item).toEqual({
      type: 'function_call_output',
      callId: 'call-1',
      output: JSON.stringify({ city: 'Madrid', celsius: 19 }),
    });
    expect(h.sink.find('tool.started')[0]).toMatchObject({
      callId: 'call-1',
      name: 'lookupWeather',
    });
    expect(h.sink.find('tool.finished')[0]).toMatchObject({ ok: true });
    expect(wire(h)).not.toContain('Madrid');
    expect(wire(h)).not.toContain('celsius');

    // The answer that follows is the same turn: stored once, with the round trip.
    session.emit({ type: 'response.created', responseId: 'r2' });
    session.emit({
      type: 'output_audio.delta',
      responseId: 'r2',
      itemId: 'a2',
      contentIndex: 0,
      format: 'pcm16_24khz',
      data: pcmBase64(40),
    });
    session.emit({
      type: 'transcript.done',
      source: 'output_audio',
      itemId: 'a2',
      contentIndex: 0,
      responseId: 'r2',
      transcript: 'Hace diecinueve grados.',
    });
    session.emit({
      type: 'response.done',
      responseId: 'r2',
      status: 'completed',
      units: [],
      usageSource: 'provider_reported',
    });
    await until('persisted', () => h.persisted.length === 1);
    expect(h.persisted[0]).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: 'Hace diecinueve grados.',
        toolInvocations: [
          expect.objectContaining({
            toolCallId: 'call-1',
            toolName: 'lookupWeather',
            args: { city: 'Madrid' },
          }),
        ],
      }),
    ]);
    // Its tools and its words are one message on the wire, the one stored.
    const storedId = h.persisted[0]![0]!.id;
    const named = h.sink.events.filter((event) =>
      ['tool.started', 'tool.finished', 'transcript.done'].includes(event.type),
    ) as Array<{ messageId: string }>;
    expect(named.length).toBe(3);
    expect(new Set(named.map((event) => event.messageId))).toEqual(new Set([storedId]));
    await h.call.end('hangup');
  });

  it('answers a tool that runs too long with a typed tool error, never an invented result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const h = harness({ tools: weatherTools(() => new Promise(() => undefined)) });
      await h.call.open(START);
      await vi.waitFor(() => expect(h.sink.types()).toContain('session.ready'));
      const session = h.session();
      session.emit({
        type: 'tool_call',
        responseId: 'r1',
        itemId: 'fc1',
        toolCallId: 'call-9',
        name: 'lookupWeather',
        argumentsDelta: '{"city":"Oslo"}',
        complete: true,
      });
      await vi.waitFor(() => expect(h.sink.types()).toContain('tool.started'));
      await vi.advanceTimersByTimeAsync(60_001);
      await vi.waitFor(() => expect(h.commands('conversation.item.create')).toHaveLength(1));
      const output = JSON.parse(
        h.commands('conversation.item.create')[0]!.item.type === 'function_call_output'
          ? (h.commands('conversation.item.create')[0]!.item as { output: string }).output
          : '{}',
      );
      expect(output.error.type).toBe('tool_timeout');
      expect(h.sink.find('tool.finished')[0]?.ok).toBe(false);
      void h.call.end('hangup');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('barge-in and transcripts', () => {
  it('never adds an answer the person talked over to the one that follows it', async () => {
    const h = await opened();
    const session = h.session();
    const answer = (
      responseId: string,
      itemId: string,
      transcript: string,
      status: 'completed' | 'cancelled',
    ) => {
      session.emit({ type: 'response.created', responseId });
      session.emit({
        type: 'transcript.done',
        source: 'output_audio',
        itemId,
        contentIndex: 0,
        responseId,
        transcript,
      });
      session.emit({
        type: 'response.done',
        responseId,
        status,
        units: [],
        usageSource: 'oxy_measured',
      });
    };
    session.emit({ type: 'input_audio.speech_started', itemId: 'u1', audioStartMs: 0 });
    // The provider answered a pause, the person went on, the answer was cancelled.
    answer('r1', 'a1', 'Sure, what', 'cancelled');
    session.emit({ type: 'input_audio.committed', itemId: 'u1' });
    session.emit({
      type: 'transcript.done',
      source: 'input_audio',
      itemId: 'u1',
      contentIndex: 0,
      transcript: 'Hey, which city is the capital of France?',
    });
    answer('r2', 'a2', 'The capital of France is Paris.', 'completed');

    await until('stored', () =>
      h.persisted.flat().some((message) => message.content.includes('Paris')),
    );
    const assistant = h.persisted.flat().filter((message) => message.role === 'assistant');
    expect(assistant.at(-1)?.content).toBe('The capital of France is Paris.');
    const transcripts = h.sink.events.filter(
      (event) => event.type === 'transcript.done' && event.role === 'assistant',
    ) as Array<{ messageId: string; itemId: string }>;
    // Two answers, two messages: never one message holding both.
    expect(new Set(transcripts.map((event) => event.messageId)).size).toBe(2);
  });

  it('stores one message per spoken item and per answer, under the id every transcript event names', async () => {
    const h = await opened();
    const session = h.session();
    // Kaana's one canonical shape (contract set 6.0.0): deltas that only append,
    // and exactly one final transcript.done per item.
    session.emit({ type: 'input_audio.speech_started', itemId: 'u1', audioStartMs: 0 });
    for (const text of [
      'Please tell me,',
      ' in one short sentence,',
      ' what is the capital of France?',
    ])
      session.emit({
        type: 'transcript.delta',
        source: 'input_audio',
        itemId: 'u1',
        contentIndex: 0,
        text,
      });
    session.emit({ type: 'input_audio.speech_stopped', itemId: 'u1', audioEndMs: 4_000 });
    session.emit({ type: 'input_audio.committed', itemId: 'u1' });
    session.emit({
      type: 'transcript.done',
      source: 'input_audio',
      itemId: 'u1',
      contentIndex: 0,
      transcript: 'Please tell me, in one short sentence, what is the capital of France?',
    });
    session.emit({ type: 'response.created', responseId: 'r1' });
    session.emit({
      type: 'transcript.delta',
      source: 'output_audio',
      itemId: 'a1',
      contentIndex: 0,
      responseId: 'r1',
      text: 'The capital of France is Paris.',
    });
    session.emit({
      type: 'transcript.done',
      source: 'output_audio',
      itemId: 'a1',
      contentIndex: 0,
      responseId: 'r1',
      transcript: 'The capital of France is Paris.',
    });
    session.emit({
      type: 'response.done',
      responseId: 'r1',
      status: 'completed',
      units: [],
      usageSource: 'oxy_measured',
    });

    await until('persisted', () => h.persisted.flat().length === 2);
    const stored = h.persisted.flat();
    expect(stored.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Please tell me, in one short sentence, what is the capital of France?'],
      ['assistant', 'The capital of France is Paris.'],
    ]);
    // One message id per role on the wire, and it is the stored one.
    const transcripts = h.sink.events.filter(
      (event) => event.type === 'transcript.delta' || event.type === 'transcript.done',
    ) as Array<{ role: string; messageId: string }>;
    for (const message of stored)
      expect(
        new Set(
          transcripts
            .filter((event) => event.role === message.role)
            .map((event) => event.messageId),
        ),
      ).toEqual(new Set([message.id]));
    // Announced to the person's other screens once each, under the same ids.
    const announced = h.announce.mock.calls.flatMap(([, , messages]) =>
      (messages as Array<{ id: string }>).map((message) => message.id),
    );
    expect(announced).toEqual(stored.map((message) => message.id));
  });

  it('truncates the interrupted item at what was played and stores the answer whole, marked', async () => {
    const h = await opened();
    const session = h.session();
    session.emit({ type: 'input_audio.speech_started', itemId: 'u1', audioStartMs: 0 });
    session.emit({ type: 'input_audio.speech_stopped', itemId: 'u1', audioEndMs: 900 });
    session.emit({ type: 'input_audio.committed', itemId: 'u1' });
    session.emit({
      type: 'transcript.done',
      source: 'input_audio',
      itemId: 'u1',
      contentIndex: 0,
      transcript: '¿Qué tiempo hace?',
    });
    session.emit({ type: 'response.created', responseId: 'r1' });
    session.emit({
      type: 'output_audio.delta',
      responseId: 'r1',
      itemId: 'a1',
      contentIndex: 0,
      format: 'pcm16_24khz',
      data: pcmBase64(40),
    });
    session.emit({
      type: 'output_audio.delta',
      responseId: 'r1',
      itemId: 'a1',
      contentIndex: 0,
      format: 'pcm16_24khz',
      data: pcmBase64(40),
    });
    session.emit({
      type: 'transcript.done',
      source: 'output_audio',
      itemId: 'a1',
      contentIndex: 0,
      responseId: 'r1',
      transcript: 'Hoy hace sol y mañana lloverá.',
    });
    await until('audio', () => h.sink.audio.length === 2);
    expect(decodeAssistantAudioFrame(h.sink.audio[0]!)?.itemId).toBe('a1');
    expect(h.sink.audioFor('a1')).toBe(80 * 48);

    // The person talks over it.
    session.emit({ type: 'input_audio.speech_started', itemId: 'u2', audioStartMs: 1_000 });
    await until('user.speech_started', () => h.sink.find('user.speech_started').length === 2);
    h.call.onPlaybackInterrupted('a1', 50);
    expect(h.commands('conversation.item.truncate')).toEqual([
      expect.objectContaining({ itemId: 'a1', contentIndex: 0, audioEndMs: 50 }),
    ]);
    session.emit({
      type: 'response.done',
      responseId: 'r1',
      status: 'cancelled',
      units: [],
      usageSource: 'provider_reported',
    });
    await until('persisted', () => h.persisted.flat().length === 2);
    expect(h.persisted.flat()).toEqual([
      expect.objectContaining({ role: 'user', content: '¿Qué tiempo hace?' }),
      expect.objectContaining({
        role: 'assistant',
        content: 'Hoy hace sol y mañana lloverá.',
        interruptedAfterMs: 50,
      }),
    ]);
    expect(h.sink.find('messages.saved')[0]?.conversationId).toBe('conv-1');
    expect(h.announce).toHaveBeenCalled();
    await h.call.end('hangup');
  });

  it('does not truncate an item that was played to the end', async () => {
    const h = await opened();
    const session = h.session();
    session.emit({ type: 'response.created', responseId: 'r1' });
    session.emit({
      type: 'output_audio.delta',
      responseId: 'r1',
      itemId: 'a1',
      contentIndex: 0,
      format: 'pcm16_24khz',
      data: pcmBase64(40),
    });
    await until('audio', () => h.sink.audio.length === 1);
    h.call.onPlaybackInterrupted('a1', 400);
    expect(h.commands('conversation.item.truncate')).toHaveLength(0);
    await h.call.end('hangup');
  });

  it('keeps the order user → assistant when the input transcript arrives late, and stores nothing for an empty response', async () => {
    const h = await opened();
    const session = h.session();
    session.emit({ type: 'input_audio.speech_started', itemId: 'u1', audioStartMs: 0 });
    session.emit({ type: 'response.created', responseId: 'r1' });
    session.emit({
      type: 'transcript.done',
      source: 'output_audio',
      itemId: 'a1',
      contentIndex: 0,
      responseId: 'r1',
      transcript: 'Claro.',
    });
    session.emit({
      type: 'response.done',
      responseId: 'r1',
      status: 'completed',
      units: [],
      usageSource: 'provider_reported',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.persisted).toHaveLength(0);
    session.emit({ type: 'input_audio.committed', itemId: 'u1' });
    session.emit({
      type: 'transcript.done',
      source: 'input_audio',
      itemId: 'u1',
      contentIndex: 0,
      transcript: 'Hola',
    });
    await until('persisted', () => h.persisted.flat().length === 2);
    expect(h.persisted.flat().map((message) => [message.role, message.content])).toEqual([
      ['user', 'Hola'],
      ['assistant', 'Claro.'],
    ]);
    // The first words of a new conversation title it.
    expect(h.titleConversation).toHaveBeenCalledWith('user-1', 'conv-1', 'Hola');

    session.emit({ type: 'input_audio.speech_started', itemId: 'u2', audioStartMs: 0 });
    session.emit({ type: 'input_audio.committed', itemId: 'u2' });
    session.emit({
      type: 'transcript.done',
      source: 'input_audio',
      itemId: 'u2',
      contentIndex: 0,
      transcript: 'Nada',
    });
    session.emit({ type: 'response.created', responseId: 'r2' });
    session.emit({
      type: 'response.done',
      responseId: 'r2',
      status: 'completed',
      units: [],
      usageSource: 'provider_reported',
    });
    await until('persisted', () => h.persisted.flat().length === 3);
    expect(h.persisted.flat().at(-1)).toMatchObject({ role: 'user', content: 'Nada' });
    await h.call.end('hangup');
    expect(h.persisted.flat()).toHaveLength(3);
  });
});

describe('limits', () => {
  it('ends an idle call with idle-timeout, once, and settles', async () => {
    const h = await opened({ limits: { idleTimeoutMs: 1_000 } });
    await until('closed', () => h.sink.types().includes('session.closed'), 2_000);
    expect(h.sink.find('session.closed')[0]?.reason).toBe('idle-timeout');
    expect(h.finishCall).toHaveBeenCalledWith(h.call.callId, 'idle_timeout');
    expect(h.session().closed).toBe(true);
    expect(h.finalize).toHaveBeenCalledOnce();
  });

  it('warns a minute before the duration ends, then ends with max-duration', async () => {
    const h = await opened({ limits: { maxDurationMs: 120, warningBeforeMs: 60 } });
    await until('closed', () => h.sink.types().includes('session.closed'), 2_000);
    expect(h.sink.find('session.warning')[0]).toMatchObject({
      code: 'ending-soon',
      remainingMs: 60,
    });
    expect(h.sink.find('session.closed')[0]?.reason).toBe('max-duration');
  });

  it('follows the upstream when Kaana closes the session for its own limit', async () => {
    const h = await opened();
    h.session().emit({
      type: 'session.closed',
      reason: 'idle_timeout',
      units: [],
      usageSource: 'provider_reported',
      closedAt: new Date().toISOString(),
    });
    await until('closed', () => h.sink.types().includes('session.closed'));
    expect(h.sink.find('session.closed')[0]?.reason).toBe('idle-timeout');
  });
});

describe('one call per person', () => {
  it('hangs up with call-moved-elsewhere when another device takes over, storing what it had', async () => {
    const h = await opened();
    const session = h.session();
    session.emit({ type: 'input_audio.speech_started', itemId: 'u1', audioStartMs: 0 });
    session.emit({ type: 'input_audio.committed', itemId: 'u1' });
    session.emit({
      type: 'transcript.done',
      source: 'input_audio',
      itemId: 'u1',
      contentIndex: 0,
      transcript: 'Último',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await h.held()!.takenOver();
    expect(h.sink.find('session.closed')[0]?.reason).toBe('call-moved-elsewhere');
    expect(h.sink.find('error')).toHaveLength(0);
    expect(h.persisted.flat().map((message) => message.content)).toContain('Último');
    // The takeover already ended the row; this task does not end it again.
    expect(h.finishCall).not.toHaveBeenCalled();
    expect(session.closed).toBe(true);
  });
});

describe('reconnection', () => {
  it('resumes the same upstream session after a dropped connection', async () => {
    const h = await opened();
    const session = h.session();
    session.drop();
    await until('reconnecting', () => h.sink.types().includes('session.reconnecting'));
    // The same session, resumed: an event after the drop reaches the client.
    session.emit({ type: 'input_audio.speech_started', itemId: 'u9', audioStartMs: 0 });
    await until('event after resume', () => h.sink.find('user.speech_started').length === 1);
    expect(h.server.sessions).toHaveLength(1);
    await h.call.end('hangup');
  });

  it('opens a new session under the same call, from the stored messages, when resume cannot work', async () => {
    const h = await opened({ history: [{ role: 'user', content: 'antes' }] });
    const first = h.session();
    // Gone while the connection was down: the resume is refused.
    first.drop();
    first.end('upstream_error');
    await until('second session', () => h.server.sessions.length === 2);
    await until('ready again', () => h.sink.find('session.ready').length === 2);
    expect(h.server.sessions[1]!.model.modelId).toBe(first.model.modelId);
    expect(h.instructionsFor).toHaveBeenLastCalledWith([{ role: 'user', content: 'antes' }]);
    expect(h.startCall).toHaveBeenCalledOnce();
    await h.call.end('hangup');
  });

  it('opens a new session when the Kaana task shuts down', async () => {
    const h = await opened();
    h.session().emit({
      type: 'session.closed',
      reason: 'server_shutdown',
      units: [],
      usageSource: 'provider_reported',
      closedAt: new Date().toISOString(),
    });
    await until('second session', () => h.server.sessions.length === 2);
    await h.call.end('hangup');
  });

  it('replays what a resuming client missed, and ends when nobody resumes in time', async () => {
    const h = await opened({ limits: { resumeWindowMs: 60 } });
    const lastSeen = h.sink.events.at(-1)!.seq;
    h.call.detach(h.sink);
    h.session().emit({ type: 'input_audio.speech_started', itemId: 'u1', audioStartMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { RecordingSink } = await import('./support.js');
    const back = new RecordingSink();
    expect(h.call.attach(back, lastSeen)).toBe(true);
    expect(back.types()).toEqual(['user.speech_started', 'session.resumed']);
    h.call.detach(back);
    await until('closed', () => h.call.isClosed);
    await h.call.ended;
    expect(h.finishCall).toHaveBeenCalledWith(h.call.callId, 'error');
  });
});

describe('credits per minute, at the real cost', () => {
  it("settles the call's minutes at the served model's price per minute", async () => {
    let clock = 1_000_000;
    const h = await opened({ now: () => clock });
    const perMinute = Number(REALTIME.pricePerMinute!.amount);
    // The block held five minutes at the catalogue's minute.
    expect(h.reservations[0]!.creditsReserved).toBe(creditsForCost(perMinute * 5));
    clock += 90_000;
    await h.call.end('hangup');
    // 90 s, silence included, at the published minute.
    expect(h.finalize).toHaveBeenCalledWith(h.reservations[0], creditsForCost(perMinute * 1.5));
    expect(h.recordAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        model: REALTIME.modelId,
        resolvedModelReference: `${REALTIME.modelId}@${REALTIME.currentRevision}`,
      }),
    );
  });

  it('ends with credits-exhausted after the spoken item when the next block is refused', async () => {
    let calls = 0;
    let clock = 1_000_000;
    const h = await opened({
      now: () => clock,
      limits: { creditCheckMs: 10 },
      reserve: async (userId, credits) => {
        calls += 1;
        return calls === 1
          ? {
              userId,
              creditsReserved: credits,
              initialFreeCredits: 0,
              initialPaidCredits: 0,
              grantKind: 'paid_balance',
            }
          : null;
      },
    });
    const session = h.session();
    session.emit({ type: 'response.created', responseId: 'r1' });
    // Four and a half minutes into a five-minute block, mid-answer.
    clock += 270_000;
    await until('next block asked', () => calls === 2);
    expect(h.sink.types()).not.toContain('session.closed');
    // Never mid-word: the answer being spoken finishes first.
    session.emit({
      type: 'response.done',
      responseId: 'r1',
      status: 'completed',
      units: [],
      usageSource: 'oxy_measured',
    });
    await until('closed', () => h.sink.types().includes('session.closed'));
    expect(h.sink.find('error')[0]?.code).toBe('credits-exhausted');
    expect(h.sink.find('session.closed')[0]?.reason).toBe('credits-exhausted');
  });
});

describe('typed failures', () => {
  it('a fatal upstream error ends the call typed, with no filler audio or text', async () => {
    const h = await opened();
    const audioBefore = h.sink.audio.length;
    h.session().emit({
      type: 'error',
      fatal: true,
      error: {
        schemaVersion: 1,
        code: 'provider_overloaded',
        message: 'busy',
        retryable: true,
        requestId: 'r',
      },
    });
    await until('closed', () => h.sink.types().includes('session.closed'));
    expect(h.sink.find('error')[0]).toMatchObject({
      code: 'realtime-failed',
      retryable: true,
      reference: h.call.callId,
    });
    expect(h.sink.audio.length).toBe(audioBefore);
    expect(h.sink.find('transcript.done')).toHaveLength(0);
    expect(h.persisted).toHaveLength(0);
  });
});
