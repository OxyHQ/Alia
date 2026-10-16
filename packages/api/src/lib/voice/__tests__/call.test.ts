import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => {
  const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: new Proxy({}, { get: () => quiet }) };
});

const { creditsForCost } = await import('../../credits-manager.js');
const { FakeKaana, FakeKaanaError, fakeRealtimeModel, fakeTranscriptionModel } = await import(
  '../../kaana/fake.js'
);
const { decodeAssistantAudioFrame } = await import('../protocol.js');
const { harness, START, until, pcmBase64, weatherTools } = await import('./support.js');

/**
 * A voice call end to end against the contract-faithful Kaana fake (ADR 0017
 * §3): opening in the ADR's order, tools run in Alia, barge-in truncated at
 * what was heard, transcripts persisted as messages, limits, credits per
 * minute and typed failures.
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

describe('opening', () => {
  it('opens a conversation with server VAD, barge-in, input transcription and the computed voice', async () => {
    const h = await opened();
    const request = h.kaana!.connectRequests[0]!;
    expect(request.model).toBe('fake/realtime-voice');
    expect(request.kind).toBe('conversation');
    expect(request.config.turnDetection).toEqual({
      type: 'server_vad',
      createResponse: true,
      interruptResponse: true,
    });
    expect(request.config.inputAudioTranscription).toEqual({ language: 'es' });
    expect(request.config.voice).toBe('fake-voice-a');
    expect(request.config.inputAudioFormat).toBe('pcm16_24khz');
    expect(request.config.outputAudioFormat).toBe('pcm16_24khz');
    expect(request.config.instructions).toBe('INSTRUCTIONS(0)');
    expect(request.config.tools?.map((tool) => tool.name)).toEqual(['lookupWeather']);
    expect(request.config.tools?.[0]?.parameters).toMatchObject({
      type: 'object',
      properties: { city: { type: 'string' } },
    });
    expect(request.limits).toMatchObject({
      maxDurationMs: 30 * 60_000,
      idleTimeoutMs: 2 * 60_000,
      maxResponses: 500,
    });
    // Kaana refuses limits it does not enforce (`limits.maxTextItems`): never sent.
    expect(request.limits).not.toHaveProperty('maxTextItems');
    expect(h.kaana!.session.options?.onBehalfOfUserId).toBe('user-1');
    expect(h.sink.types().slice(0, 2)).toEqual(['session.accepted', 'session.ready']);
    const ready = h.sink.find('session.ready')[0]!;
    expect(ready.model.id).toBe('fake/realtime-voice@2026-10-01');
    // The device never sees the instructions, a schema or the upstream voice id.
    expect(wire(h)).not.toContain('INSTRUCTIONS');
    expect(wire(h)).not.toContain('properties');
    expect(wire(h)).not.toContain('fake-voice-a');
    // The one-call rule ran, and the first credit block is held.
    expect(h.startCall).toHaveBeenCalledOnce();
    expect(h.reserve).toHaveBeenCalledOnce();
    await h.call.end('hangup');
  });

  it('acknowledges audio only once it was appended to a created session', async () => {
    const h = harness();
    const kaana = h.kaana!;
    kaana.autoCreate = false;
    await h.call.open(START);
    h.call.onClientAudio(new Uint8Array(1920));
    expect(kaana.session.appendCount).toBe(0);
    expect(h.sink.types()).not.toContain('input.ready');
    kaana.session.emit({
      type: 'session.created',
      model: 'fake/realtime-voice@2026-10-01',
      kind: 'conversation',
      config: kaana.session.request.config,
      limits: {
        maxDurationMs: 1_800_000,
        idleTimeoutMs: 120_000,
        maxInputAudioBytes: 1,
        maxOutputAudioBytes: 1,
        maxResponses: 500,
      },
      resumeWindowMs: 30_000,
      startedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    });
    await until('session.ready', () => h.sink.types().includes('session.ready'));
    h.call.onClientAudio(new Uint8Array(1920));
    h.call.onClientAudio(new Uint8Array(1920));
    expect(kaana.session.appendCount).toBe(2);
    expect(h.sink.find('input.ready')).toHaveLength(1);
    // A frame over the contract's bound is not forwarded.
    h.call.onClientAudio(new Uint8Array(49_153));
    expect(kaana.session.appendCount).toBe(2);
    await h.call.end('hangup');
  });

  it('refuses a person without voice-mode on the server, before anything is reserved or dialled', async () => {
    const h = harness({ voiceMode: false });
    await h.call.open(START);
    expect(h.sink.find('error')[0]?.code).toBe('plan-required');
    expect(h.sink.find('session.closed')[0]?.reason).toBe('error');
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.startCall).not.toHaveBeenCalled();
    expect(h.kaana!.connectRequests).toHaveLength(0);
    expect(h.sink.closed).toBe(true);
  });

  it('refuses when the credits do not cover the first block, without taking over another call', async () => {
    const h = harness({ reserve: async () => null });
    await h.call.open(START);
    expect(h.sink.find('error')[0]?.code).toBe('credits-exhausted');
    expect(h.startCall).not.toHaveBeenCalled();
    expect(h.kaana!.connectRequests).toHaveLength(0);
  });

  it('refuses an agent it cannot verify, and a product agent, as agent-unavailable', async () => {
    const missing = harness({ turnAgent: { kind: 'unavailable', reason: 'not_found' } });
    await missing.call.open({ ...START, agentId: 'agent-1' });
    expect(missing.sink.find('error')[0]?.code).toBe('agent-unavailable');

    const product = harness({
      turnAgent: { kind: 'agent', agent: { _id: 'agent-2', applicationId: 'app-9' } as never },
    });
    await product.call.open({ ...START, agentId: 'agent-2' });
    expect(product.sink.find('error')[0]?.code).toBe('agent-unavailable');
    expect(product.kaana!.connectRequests).toHaveLength(0);
  });

  it('is realtime-unavailable without a Kaana client, or with no model that can hold the call', async () => {
    const none = harness({ kaana: null });
    await none.call.open(START);
    expect(none.sink.find('error')[0]?.code).toBe('realtime-unavailable');

    const noRealtime = harness({ models: [fakeTranscriptionModel()] });
    await noRealtime.call.open(START);
    expect(noRealtime.sink.find('error')[0]?.code).toBe('realtime-unavailable');
    expect(noRealtime.reserve).not.toHaveBeenCalled();
  });

  it('tries the next candidate only when the model itself refused', async () => {
    const first = fakeRealtimeModel({ modelId: 'fake/cheap' });
    first.pricing!.unitPrices[0]!.amount = '0.01';
    const second = fakeRealtimeModel({ modelId: 'fake/dear' });
    const kaana = new FakeKaana({ models: [second, first] });
    kaana.failConnect.push({ model: 'fake/cheap', error: new FakeKaanaError('model_not_found') });
    const h = await opened({ kaana });
    expect(kaana.connectRequests.map((request) => request.model)).toEqual([
      'fake/cheap',
      'fake/dear',
    ]);
    await h.call.end('hangup');

    const billing = new FakeKaana({ models: [second, first] });
    billing.failConnect.push({
      model: 'fake/cheap',
      error: new FakeKaanaError('insufficient_balance'),
    });
    const refused = harness({ kaana: billing });
    await refused.call.open(START);
    expect(billing.connectRequests.map((request) => request.model)).toEqual(['fake/cheap']);
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
    expect(h.kaana!.connectRequests).toHaveLength(0);
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
    const session = h.kaana!.session;
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
    await until('response.create', () => session.commands('response.create').length === 1);
    expect(execute).toHaveBeenCalledWith(
      { city: 'Madrid' },
      expect.objectContaining({ toolCallId: 'call-1' }),
    );
    const output = session.commands('conversation.item.create')[0]!;
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
    await h.call.end('hangup');
  });

  it('answers a tool that runs too long with a typed tool error, never an invented result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const h = harness({ tools: weatherTools(() => new Promise(() => undefined)) });
      await h.call.open(START);
      await vi.waitFor(() => expect(h.sink.types()).toContain('session.ready'));
      const session = h.kaana!.session;
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
      await vi.waitFor(() => expect(session.commands('conversation.item.create')).toHaveLength(1));
      const output = JSON.parse(
        session.commands('conversation.item.create')[0]!.item.type === 'function_call_output'
          ? (session.commands('conversation.item.create')[0]!.item as { output: string }).output
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
  it('truncates the interrupted item at what was played and stores the answer whole, marked', async () => {
    const h = await opened();
    const session = h.kaana!.session;
    session.emit({ type: 'input_audio.speech_started', itemId: 'u1', audioStartMs: 0 });
    session.emit({ type: 'input_audio.speech_stopped', itemId: 'u1', audioEndMs: 900 });
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
    expect(session.commands('conversation.item.truncate')).toEqual([
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
    const session = h.kaana!.session;
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
    expect(session.commands('conversation.item.truncate')).toHaveLength(0);
    await h.call.end('hangup');
  });

  it('keeps the order user → assistant when the input transcript arrives late, and stores nothing for an empty response', async () => {
    const h = await opened();
    const session = h.kaana!.session;
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
    const h = await opened({ limits: { idleTimeoutMs: 40 } });
    await until('closed', () => h.sink.types().includes('session.closed'), 2_000);
    expect(h.sink.find('session.closed')[0]?.reason).toBe('idle-timeout');
    expect(h.finishCall).toHaveBeenCalledWith(h.call.callId, 'idle_timeout');
    expect(h.kaana!.session.closeCount).toBe(1);
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
    h.kaana!.session.emit({
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
    const session = h.kaana!.session;
    session.emit({ type: 'input_audio.speech_started', itemId: 'u1', audioStartMs: 0 });
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
    expect(session.closeCount).toBe(1);
  });
});

describe('reconnection', () => {
  it('resumes the same upstream session after a dropped connection', async () => {
    const h = await opened();
    const session = h.kaana!.session;
    session.dropConnection();
    await until('resumed', () => session.resumeCount === 1);
    expect(h.sink.types()).toContain('session.reconnecting');
    expect(h.kaana!.sessions).toHaveLength(1);
    session.emit({ type: 'input_audio.speech_started', itemId: 'u9', audioStartMs: 0 });
    await until('event after resume', () => h.sink.find('user.speech_started').length === 1);
    await h.call.end('hangup');
  });

  it('opens a new session under the same call, from the stored messages, when resume cannot work', async () => {
    const h = await opened({ history: [{ role: 'user', content: 'antes' }] });
    const first = h.kaana!.session;
    first.failResume = true;
    first.dropConnection();
    await until('second session', () => h.kaana!.sessions.length === 2);
    await until('ready again', () => h.sink.find('session.ready').length === 2);
    expect(h.kaana!.sessions[1]!.request.model).toBe(first.request.model);
    expect(h.instructionsFor).toHaveBeenLastCalledWith([{ role: 'user', content: 'antes' }]);
    expect(h.startCall).toHaveBeenCalledOnce();
    await h.call.end('hangup');
  });

  it('opens a new session when the Kaana task shuts down', async () => {
    const h = await opened();
    h.kaana!.session.emit({
      type: 'session.closed',
      reason: 'server_shutdown',
      units: [],
      usageSource: 'provider_reported',
      closedAt: new Date().toISOString(),
    });
    await until('second session', () => h.kaana!.sessions.length === 2);
    await h.call.end('hangup');
  });

  it('replays what a resuming client missed, and ends when nobody resumes in time', async () => {
    const h = await opened({ limits: { resumeWindowMs: 60 } });
    const lastSeen = h.sink.events.at(-1)!.seq;
    h.call.detach(h.sink);
    h.kaana!.session.emit({ type: 'input_audio.speech_started', itemId: 'u1', audioStartMs: 0 });
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
  it('settles from the session units Kaana measured, at the served model price', async () => {
    const h = await opened();
    // 90 s at $0.08 per minute = $0.12.
    h.kaana!.session.closeUnits = [{ unit: 'session_milliseconds', quantity: 90_000 }];
    await h.call.end('hangup');
    expect(h.finalize).toHaveBeenCalledWith(h.reservations[0], creditsForCost(0.12));
    // The block held five minutes at the catalogue's minute.
    expect(h.reservations[0]!.creditsReserved).toBe(creditsForCost(0.08 * 5));
    expect(h.recordAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'fake/realtime-voice',
        resolvedModelReference: 'fake/realtime-voice@2026-10-01',
      }),
    );
  });

  it('ends with credits-exhausted after the spoken item when the next block is refused', async () => {
    let calls = 0;
    const h = await opened({
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
    const session = h.kaana!.session;
    session.emit({ type: 'response.created', responseId: 'r1' });
    // Four and a half minutes of audio out, reported: the block is nearly spent.
    session.emit({
      type: 'response.done',
      responseId: 'r1',
      status: 'completed',
      units: [{ unit: 'session_milliseconds', quantity: 270_000 }],
      usageSource: 'provider_reported',
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
    h.kaana!.session.emit({
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
