import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceCall, type VoiceCallSnapshot } from '../../src/lib/voice-call';
import { VoiceLevelChannel } from '../../src/lib/voice-levels';
import { FakeEngine, FakeSocket, settle } from '../support/fake-voice';

/**
 * A call with its two edges replaced — the socket to Alia and the device's
 * audio — and everything between them real: the protocol, the honest state
 * machine, barge-in, resume.
 */
let sockets: FakeSocket[];
let engine: FakeEngine;
let token: string | null;
let snapshots: VoiceCallSnapshot[];
let saved: Array<{ conversationId: string; ids: readonly string[] }>;

function newCall(overrides: Partial<ConstructorParameters<typeof VoiceCall>[0]> = {}): VoiceCall {
  return new VoiceCall({
    apiUrl: 'https://api.alia.test',
    getToken: () => token,
    conversationId: 'conv-1',
    agentId: 'agent-1',
    voice: 'female',
    locale: 'es-ES',
    createEngine: () => engine,
    openSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    levels: new VoiceLevelChannel(),
    onChange: (snapshot) => snapshots.push(snapshot),
    onMessagesSaved: (conversationId, ids) => saved.push({ conversationId, ids }),
    resumeRetryMs: 10,
    ...overrides,
  });
}

const kind = (call: VoiceCall) => call.snapshot().state.kind;
const socket = () => sockets.at(-1)!;

/** Through `session.accepted`: the call is still connecting. */
async function accepted(call: VoiceCall): Promise<void> {
  await call.start();
  socket().open();
  socket().receive({ type: 'auth.ok' });
  socket().receive({ type: 'session.accepted', voiceSessionId: 'vs-1', callId: 'call-1', seq: 0 });
}

const READY = {
  type: 'session.ready',
  model: { id: 'openai/gpt-realtime', displayName: 'GPT Realtime', publisher: 'OpenAI' },
  maxDurationMs: 1_800_000,
  idleTimeoutMs: 120_000,
  resumeWindowMs: 30_000,
  seq: 1,
};

/** All the way to listening. */
async function live(call: VoiceCall): Promise<void> {
  await accepted(call);
  socket().receive(READY);
  engine.capture();
  socket().receive({ type: 'input.ready', seq: 2 });
}

beforeEach(() => {
  sockets = [];
  engine = new FakeEngine();
  token = 'oxy-session';
  snapshots = [];
  saved = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('opening a call', () => {
  it('authenticates first, then starts the session for the conversation and agent', async () => {
    const call = newCall();
    await call.start();
    expect(socket().url).toBe('wss://api.alia.test/v1/voice/session');
    expect(socket().binaryType).toBe('arraybuffer');
    socket().open();
    expect(socket().events()).toEqual([{ type: 'auth', token: 'oxy-session' }]);
    socket().receive({ type: 'auth.ok' });
    expect(socket().events()[1]).toEqual({
      type: 'session.start',
      protocol: 2,
      conversationId: 'conv-1',
      agentId: 'agent-1',
      voice: 'female',
      locale: 'es-ES',
    });
  });

  it('says listening only after the session is ready, a buffer was captured AND Alia acknowledged audio', async () => {
    const call = newCall();
    await accepted(call);
    expect(kind(call)).toBe('connecting');

    // Captured before the session is ready: counted, never sent.
    engine.capture();
    expect(socket().audio()).toHaveLength(0);
    expect(kind(call)).toBe('connecting');

    socket().receive(READY);
    expect(kind(call)).toBe('connecting');
    engine.capture();
    expect(socket().audio()).toHaveLength(1);
    expect(kind(call)).toBe('connecting');

    socket().receive({ type: 'input.ready', seq: 2 });
    expect(kind(call)).toBe('listening');
    expect(call.snapshot().model?.displayName).toBe('GPT Realtime');
  });

  it('does not count Alia acknowledging audio as listening before the microphone delivered anything', async () => {
    const call = newCall();
    await accepted(call);
    socket().receive(READY);
    socket().receive({ type: 'input.ready', seq: 2 });
    expect(kind(call)).toBe('connecting');
    engine.capture();
    expect(kind(call)).toBe('listening');
  });

  it('ends as not-authenticated with no token, without opening the microphone', async () => {
    token = null;
    const call = newCall();
    await call.start();
    expect(call.snapshot().state).toEqual({ kind: 'error', code: 'not-authenticated' });
    expect(engine.handlers).toBeNull();
    expect(sockets).toHaveLength(0);
  });

  it('ends with the device error when the microphone is refused', async () => {
    engine.failWith = 'mic-denied';
    const call = newCall();
    await call.start();
    expect(call.snapshot().state).toEqual({ kind: 'error', code: 'mic-denied' });
    expect(sockets).toHaveLength(0);
  });
});

describe('the conversation', () => {
  it('sends microphone frames once live, and nothing while muted', async () => {
    const call = newCall();
    await live(call);
    const before = socket().audio().length;
    engine.capture();
    expect(socket().audio()).toHaveLength(before + 1);
    call.setMuted(true);
    engine.capture();
    expect(socket().audio()).toHaveLength(before + 1);
    expect(call.snapshot().isMuted).toBe(true);
  });

  it('moves through user-speaking, thinking and speaking — speaking only once audio PLAYS', async () => {
    const call = newCall();
    await live(call);
    socket().receive({ type: 'user.speech_started', itemId: 'u1', seq: 3 });
    expect(kind(call)).toBe('user-speaking');
    socket().receive({ type: 'user.speech_stopped', itemId: 'u1', seq: 4 });
    expect(kind(call)).toBe('thinking');

    socket().receiveAudio('a1', new Uint8Array(4800));
    expect(engine.enqueued).toEqual([{ itemId: 'a1', bytes: 4800 }]);
    expect(kind(call)).toBe('thinking');
    engine.play('a1');
    expect(kind(call)).toBe('speaking');

    socket().receive({ type: 'assistant.done', itemId: 'a1', status: 'completed', seq: 5 });
    expect(kind(call)).toBe('speaking');
    engine.drain();
    expect(kind(call)).toBe('listening');
  });

  it('keeps both sides of the transcript, live and then settled', async () => {
    const call = newCall();
    await live(call);
    socket().receive({
      type: 'transcript.delta',
      role: 'user',
      messageId: 'voice-user-1',
      itemId: 'u1',
      text: 'Hola',
      seq: 3,
    });
    socket().receive({
      type: 'transcript.done',
      role: 'user',
      messageId: 'voice-user-1',
      itemId: 'u1',
      text: 'Hola, Alia',
      seq: 4,
    });
    socket().receive({
      type: 'transcript.delta',
      role: 'assistant',
      messageId: 'voice-turn-1',
      itemId: 'a1',
      text: 'Hola',
      seq: 5,
    });
    socket().receive({
      type: 'transcript.delta',
      role: 'assistant',
      messageId: 'voice-turn-1',
      itemId: 'a1',
      text: ', ¿qué tal?',
      seq: 6,
    });
    const messages = call.snapshot().messages;
    expect(messages.map((m) => [m.id, m.role, m.content, m.isStreaming])).toEqual([
      ['voice-user-1', 'user', 'Hola, Alia', false],
      ['voice-turn-1', 'assistant', 'Hola, ¿qué tal?', true],
    ]);
    socket().receive({ type: 'assistant.done', itemId: 'a1', status: 'completed', seq: 7 });
    expect(call.snapshot().messages[1]?.isStreaming).toBe(false);
  });

  it('is one message per stored message: repeated transcripts, and a turn of two items', async () => {
    const call = newCall();
    await live(call);
    let seq = 3;
    const receive = (event: Record<string, unknown>) => socket().receive({ ...event, seq: seq++ });
    // xAI: a growing transcript at every pause, and the final one repeated.
    for (const text of [
      'Busca',
      'Busca el tiempo',
      'Busca el tiempo en Madrid',
      'Busca el tiempo en Madrid',
    ])
      receive({
        type: 'transcript.done',
        role: 'user',
        messageId: 'voice-user-1',
        itemId: 'u1',
        text,
      });
    // A turn that called a tool, then answered: two items, one message.
    receive({
      type: 'transcript.done',
      role: 'assistant',
      messageId: 'voice-turn-1',
      itemId: 'a1',
      text: 'Lo miro.',
    });
    receive({
      type: 'transcript.delta',
      role: 'assistant',
      messageId: 'voice-turn-1',
      itemId: 'a2',
      text: 'Hace sol',
    });
    receive({
      type: 'transcript.delta',
      role: 'assistant',
      messageId: 'voice-turn-1',
      itemId: 'a2',
      text: ', 24 grados.',
    });
    receive({ type: 'assistant.done', itemId: 'a2', status: 'completed' });
    expect(call.snapshot().messages.map((m) => [m.id, m.role, m.content, m.isStreaming])).toEqual([
      ['voice-user-1', 'user', 'Busca el tiempo en Madrid', false],
      ['voice-turn-1', 'assistant', 'Lo miro. Hace sol, 24 grados.', false],
    ]);
  });

  it("draws an answer's tools inside its message, by name and state", async () => {
    const call = newCall();
    await live(call);
    let seq = 3;
    const receive = (event: Record<string, unknown>) => socket().receive({ ...event, seq: seq++ });
    receive({
      type: 'transcript.done',
      role: 'assistant',
      messageId: 'voice-turn-1',
      itemId: 'a1',
      text: 'Busco tus posts.',
    });
    receive({
      type: 'tool.started',
      messageId: 'voice-turn-1',
      callId: 'c1',
      name: 'oxy_mention__search',
    });
    receive({
      type: 'tool.started',
      messageId: 'voice-turn-1',
      callId: 'c2',
      name: 'oxy_mention__get_user_feed',
    });
    receive({
      type: 'tool.finished',
      messageId: 'voice-turn-1',
      callId: 'c1',
      name: 'oxy_mention__search',
      ok: false,
    });
    receive({
      type: 'transcript.done',
      role: 'assistant',
      messageId: 'voice-turn-1',
      itemId: 'a2',
      text: 'No pude recuperarlos.',
    });
    const [message, ...rest] = call.snapshot().messages;
    expect(rest).toEqual([]);
    expect(message?.content).toBe('Busco tus posts. No pude recuperarlos.');
    expect(message?.toolInvocations).toEqual([
      { toolCallId: 'c1', toolName: 'oxy_mention__search', state: 'result' },
      { toolCallId: 'c2', toolName: 'oxy_mention__get_user_feed', state: 'call' },
    ]);
  });

  it('ignores a tool event without the message it belongs to', async () => {
    const call = newCall();
    await live(call);
    socket().receive({ type: 'tool.started', callId: 'c1', name: 'x', seq: 3 });
    expect(call.snapshot().messages).toEqual([]);
  });

  it('ignores a transcript event without the message it belongs to', async () => {
    const call = newCall();
    await live(call);
    socket().receive({ type: 'transcript.done', role: 'user', itemId: 'u1', text: 'Hola', seq: 3 });
    expect(call.snapshot().messages).toEqual([]);
  });

  it('shows a running tool by name, and thinks until the answer comes', async () => {
    const call = newCall();
    await live(call);
    socket().receive({ type: 'user.speech_stopped', itemId: 'u1', seq: 3 });
    socket().receive({
      type: 'tool.started',
      messageId: 'voice-turn-1',
      callId: 't1',
      name: 'getWeather',
      seq: 4,
    });
    expect(call.snapshot().state).toEqual({ kind: 'using-tool', tool: 'getWeather' });
    socket().receive({
      type: 'tool.finished',
      messageId: 'voice-turn-1',
      callId: 't1',
      name: 'getWeather',
      ok: true,
      seq: 5,
    });
    expect(kind(call)).toBe('thinking');
    // The response that called the tool ends; the one that answers follows.
    socket().receive({ type: 'assistant.done', itemId: null, status: 'completed', seq: 6 });
    expect(kind(call)).toBe('thinking');
  });

  it('goes back to listening when a response ends with nothing to say', async () => {
    const call = newCall();
    await live(call);
    socket().receive({ type: 'user.speech_stopped', itemId: 'u1', seq: 3 });
    socket().receive({ type: 'assistant.done', itemId: null, status: 'completed', seq: 4 });
    expect(kind(call)).toBe('listening');
  });

  it('hands stored messages to the host so it can refresh the thread', async () => {
    const call = newCall();
    await live(call);
    socket().receive({
      type: 'messages.saved',
      conversationId: 'conv-1',
      messageIds: ['m1', 'm2'],
      seq: 3,
    });
    expect(saved).toEqual([{ conversationId: 'conv-1', ids: ['m1', 'm2'] }]);
  });

  it('ignores an event it has already seen (a replay)', async () => {
    const call = newCall();
    await live(call);
    socket().receive({
      type: 'tool.started',
      messageId: 'voice-turn-1',
      callId: 't1',
      name: 'x',
      seq: 2,
    });
    expect(kind(call)).toBe('listening');
  });
});

describe('barge-in', () => {
  it('flushes playback and tells Alia how much of the answer was heard', async () => {
    const call = newCall();
    await live(call);
    socket().receiveAudio('a1', new Uint8Array(4800));
    engine.play('a1');
    engine.heard = { itemId: 'a1', playedMs: 740 };

    socket().receive({ type: 'user.speech_started', itemId: 'u2', seq: 3 });
    expect(kind(call)).toBe('user-speaking');
    expect(engine.flushes).toBe(1);
    await settle();
    expect(socket().events().at(-1)).toEqual({
      type: 'playback.interrupted',
      itemId: 'a1',
      playedMs: 740,
    });

    // Frames of the interrupted answer still in flight are not played.
    socket().receiveAudio('a1', new Uint8Array(4800));
    expect(engine.enqueued).toHaveLength(1);
    // The next answer is.
    socket().receiveAudio('a2', new Uint8Array(4800));
    expect(engine.enqueued.map((e) => e.itemId)).toEqual(['a1', 'a2']);
  });

  it('reports nothing when nothing was playing', async () => {
    const call = newCall();
    await live(call);
    socket().receive({ type: 'user.speech_started', itemId: 'u1', seq: 3 });
    await settle();
    expect(
      socket()
        .events()
        .some((e) => e.type === 'playback.interrupted'),
    ).toBe(false);
  });
});

describe('reconnection', () => {
  it('resumes a dropped socket from the last event seen, reading reconnecting meanwhile', async () => {
    const call = newCall();
    await live(call);
    socket().receive({
      type: 'tool.started',
      messageId: 'voice-turn-1',
      callId: 't',
      name: 'x',
      seq: 7,
    });
    socket().receive({
      type: 'tool.finished',
      messageId: 'voice-turn-1',
      callId: 't',
      name: 'x',
      ok: true,
      seq: 8,
    });
    socket().drop();
    expect(kind(call)).toBe('reconnecting');

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    socket().open();
    socket().receive({ type: 'auth.ok' });
    expect(socket().events().at(-1)).toEqual({
      type: 'session.resume',
      protocol: 2,
      voiceSessionId: 'vs-1',
      afterSeq: 8,
    });
    expect(kind(call)).toBe('reconnecting');
    socket().receive({ type: 'session.resumed', afterSeq: 8, seq: 9 });
    expect(kind(call)).toBe('listening');
  });

  it('reads reconnecting while Alia re-opens the session upstream, and listening once ready again', async () => {
    const call = newCall();
    await live(call);
    socket().receive({ type: 'session.reconnecting', seq: 3 });
    expect(kind(call)).toBe('reconnecting');
    socket().receive({ ...READY, seq: 4 });
    expect(kind(call)).toBe('listening');
  });

  it('ends as resume-unavailable when Alia cannot pick the call up', async () => {
    const call = newCall();
    await live(call);
    socket().drop();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    socket().open();
    socket().receive({ type: 'auth.ok' });
    socket().receive({
      type: 'error',
      code: 'resume-unavailable',
      message: 'gone',
      retryable: false,
      reference: 'r',
    });
    socket().drop();
    expect(call.snapshot().state).toEqual({ kind: 'error', code: 'resume-unavailable' });
  });

  it('gives up as connection-lost after the resume window', async () => {
    const call = newCall({ resumeRetryMs: 5 });
    await accepted(call);
    socket().receive({ ...READY, resumeWindowMs: 20 });
    socket().drop();
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(1));
    // Every attempt fails to connect.
    await vi.waitFor(
      () => {
        if (sockets.at(-1)!.readyState === 0) sockets.at(-1)!.drop();
        expect(call.snapshot().state).toEqual({ kind: 'error', code: 'connection-lost' });
      },
      { timeout: 2_000, interval: 5 },
    );
  });

  it('is connection-lost when the socket drops before any session existed', async () => {
    const call = newCall();
    await call.start();
    socket().open();
    socket().drop();
    expect(call.snapshot().state).toEqual({ kind: 'error', code: 'connection-lost' });
  });
});

describe('the end of a call', () => {
  it('treats a call moved to another device as an ending, not an error', async () => {
    const call = newCall();
    await live(call);
    socket().receive({ type: 'session.closed', reason: 'call-moved-elsewhere', seq: 3 });
    expect(call.snapshot().state).toEqual({ kind: 'ended', reason: 'call-moved-elsewhere' });
    expect(engine.stopped).toBe(true);
  });

  it('ends with the typed code Alia sent before closing', async () => {
    const call = newCall();
    await live(call);
    socket().receive({
      type: 'error',
      code: 'credits-exhausted',
      message: 'out',
      retryable: false,
      reference: 'ref',
      seq: 3,
    });
    socket().receive({ type: 'session.closed', reason: 'error', seq: 4 });
    expect(call.snapshot().state).toEqual({ kind: 'error', code: 'credits-exhausted' });
  });

  it('refuses before a session exists with a typed code (plan-required)', async () => {
    const call = newCall();
    await call.start();
    socket().open();
    socket().receive({ type: 'auth.ok' });
    socket().receive({
      type: 'error',
      code: 'plan-required',
      message: 'paid',
      retryable: false,
      reference: 'r',
    });
    socket().drop();
    expect(call.snapshot().state).toEqual({ kind: 'error', code: 'plan-required' });
  });

  it('hangs up with session.end and releases the device', async () => {
    const call = newCall();
    await live(call);
    call.hangUp();
    expect(sockets[0]!.events().at(-1)).toEqual({ type: 'session.end' });
    expect(call.snapshot().state).toEqual({ kind: 'ended', reason: 'hangup' });
    expect(engine.stopped).toBe(true);
    expect(sockets[0]!.close).toHaveBeenCalled();
  });

  it('warns when the call is about to reach its time limit', async () => {
    const call = newCall();
    await live(call);
    socket().receive({ type: 'session.warning', code: 'ending-soon', remainingMs: 60_000, seq: 3 });
    expect(call.snapshot().endingSoonMs).toBe(60_000);
  });
});

describe('the token', () => {
  it('re-sends a fresher Oxy token on the open socket', async () => {
    vi.useFakeTimers();
    const call = newCall({ tokenRefreshMs: 1_000 });
    await live(call);
    token = 'oxy-session-2';
    vi.advanceTimersByTime(1_000);
    expect(socket().events().at(-1)).toEqual({ type: 'auth', token: 'oxy-session-2' });
    // A later auth.ok does not start a second session.
    socket().receive({ type: 'auth.ok' });
    expect(
      socket()
        .events()
        .filter((e) => e.type === 'session.start'),
    ).toHaveLength(1);
    call.hangUp();
  });
});
