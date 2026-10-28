import { describe, expect, it, vi } from 'vitest';
import {
  DICTATION_PROTOCOL_VERSION,
  type DictationServerEvent,
  type DictationSocket,
  dictationStreamUrl,
  openDictationStream,
  parseDictationServerEvent,
} from '../../src/dictation';

class FakeSocket implements DictationSocket {
  binaryType = 'blob';
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: Array<string | Uint8Array> = [];
  closedWith: number | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer));
  }
  close(code?: number): void {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  texts(): Array<Record<string, unknown>> {
    return this.sent
      .filter((frame): frame is string => typeof frame === 'string')
      .map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }
  binaries(): Uint8Array[] {
    return this.sent.filter((frame): frame is Uint8Array => typeof frame !== 'string');
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(overrides: Partial<Parameters<typeof openDictationStream>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const events: DictationServerEvent[] = [];
  const getToken = vi.fn(async (_target: string) => 'person-token');
  const stream = openDictationStream({
    apiUrl: 'https://api.alia.test/',
    getToken,
    language: 'es-ES',
    onEvent: (event) => events.push(event),
    openSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    ...overrides,
  } as Parameters<typeof openDictationStream>[0]);
  return { stream, socket: () => sockets[0]!, events, getToken };
}

describe('openDictationStream', () => {
  it('authenticates with the person’s token for the socket, then starts protocol 1', async () => {
    const { socket, getToken } = harness();
    expect(socket().url).toBe('wss://api.alia.test/v1/audio/transcriptions/stream');
    socket().open();
    await flush();
    expect(getToken.mock.calls[0]?.[0]).toBe(socket().url);
    expect(socket().texts()).toEqual([
      { type: 'auth', token: 'person-token' },
      {
        type: 'dictation.start',
        protocol: DICTATION_PROTOCOL_VERSION,
        sampleRate: 24_000,
        language: 'es-ES',
      },
    ]);
    expect(socket().binaryType).toBe('arraybuffer');
  });

  it('holds the audio spoken before the socket opens and sends it after the start', async () => {
    const { stream, socket } = harness();
    stream.append(new Uint8Array([1, 2]));
    stream.append(new Uint8Array([3, 4]));
    expect(socket().sent).toEqual([]);
    socket().open();
    await flush();
    stream.append(new Uint8Array([5, 6]));
    expect(
      socket()
        .sent.slice(0, 2)
        .every((frame) => typeof frame === 'string'),
    ).toBe(true);
    expect(socket().binaries()).toEqual([
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
      new Uint8Array([5, 6]),
    ]);
  });

  it('reports Alia’s events in order and settles on dictation.closed', async () => {
    const { stream, socket, events } = harness();
    socket().open();
    await flush();
    socket().receive({ type: 'dictation.ready', maxDurationMs: 300_000 });
    socket().receive({ type: 'transcript.interim', segment: 0, text: 'hol' });
    socket().receive({ type: 'not.an.event' });
    socket().receive({ type: 'transcript.final', segment: 0, text: 'Hola.' });
    socket().receive({ type: 'dictation.closed', reason: 'ended' });
    await expect(stream.closed).resolves.toBe('ended');
    expect(events.map((event) => event.type)).toEqual([
      'dictation.ready',
      'transcript.interim',
      'transcript.final',
      'dictation.closed',
    ]);
    socket().receive({ type: 'transcript.final', segment: 1, text: 'late' });
    expect(events).toHaveLength(4);
  });

  it('commits and ends on request; end resolves when Alia closes', async () => {
    const { stream, socket } = harness();
    socket().open();
    await flush();
    stream.commit();
    const ending = stream.end();
    stream.append(new Uint8Array([9]));
    expect(socket().texts().slice(2)).toEqual([
      { type: 'dictation.commit' },
      { type: 'dictation.end' },
    ]);
    expect(socket().binaries()).toEqual([]);
    socket().receive({ type: 'dictation.closed', reason: 'ended' });
    await expect(ending).resolves.toBe('ended');
    expect(socket().closedWith).toBe(1000);
  });

  it('ends on its own when Alia does not close in time', async () => {
    const { stream, socket, events } = harness({ endTimeoutMs: 5 });
    socket().open();
    await flush();
    await expect(stream.end()).resolves.toBe('ended');
    expect(events.at(-1)).toEqual({ type: 'dictation.closed', reason: 'ended' });
  });

  it('reports a lost connection as a retryable failure', async () => {
    const { stream, socket, events } = harness();
    socket().open();
    await flush();
    socket().drop();
    await expect(stream.closed).resolves.toBe('error');
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'TRANSCRIPTION_FAILED', retryable: true }),
      { type: 'dictation.closed', reason: 'error' },
    ]);
  });

  it('refuses to start without the person’s token', async () => {
    const { stream, socket, events } = harness({ getToken: async () => null });
    socket().open();
    await expect(stream.closed).resolves.toBe('error');
    expect(events[0]).toMatchObject({ type: 'error', code: 'NOT_AUTHENTICATED' });
    expect(socket().texts()).toEqual([]);
  });

  it('takes a token directly too', async () => {
    const { socket } = harness({ getToken: undefined, token: 'given' } as never);
    socket().open();
    await flush();
    expect(socket().texts()[0]).toEqual({ type: 'auth', token: 'given' });
  });

  it('drops silently when its signal aborts', async () => {
    const controller = new AbortController();
    const { stream, socket, events } = harness({ signal: controller.signal });
    socket().open();
    await flush();
    controller.abort();
    await expect(stream.closed).resolves.toBe('ended');
    expect(events).toEqual([]);
    expect(socket().closedWith).toBe(1000);
  });
});

describe('the protocol', () => {
  it('maps an Alia origin to its socket', () => {
    expect(dictationStreamUrl('http://localhost:3000')).toBe(
      'ws://localhost:3000/v1/audio/transcriptions/stream',
    );
  });

  it('reads only protocol 1’s events', () => {
    expect(parseDictationServerEvent('{"type":"transcript.delta","segment":2,"text":"a"}')).toEqual(
      {
        type: 'transcript.delta',
        segment: 2,
        text: 'a',
      },
    );
    expect(
      parseDictationServerEvent('{"type":"transcript.delta","segment":-1,"text":"a"}'),
    ).toBeNull();
    expect(
      parseDictationServerEvent('{"type":"error","code":"SOMETHING","message":"x"}'),
    ).toBeNull();
    expect(parseDictationServerEvent('{"type":"dictation.closed","reason":"later"}')).toBeNull();
    expect(parseDictationServerEvent('not json')).toBeNull();
  });
});
