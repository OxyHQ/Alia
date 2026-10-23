import { createServer, type Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { OxyServices } from '@oxy.so/core';
import { requestTranscription } from '../../src/lib/dictation';
import { requestSpeechClip } from '../../src/lib/speech-synthesis';
import { bindAudioSession } from '../../src/lib/audio-session-binding';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP port');
  return `http://127.0.0.1:${address.port}`;
}
function token(userId: string, revision = 0, operatorId = 'operator') {
  return `e30.${Buffer.from(JSON.stringify({ userId, operatorId, sessionId: 'session', exp: Math.floor(Date.now() / 1000) + 3600 + revision })).toString('base64url')}.sig`;
}

describe('audio with the shared Oxy transport', () => {
  it('keeps speech and multipart dictation on the current account, fences a switch, and rejects redirects', async () => {
    let foreignDeliveries = 0;
    const foreign = createServer((_req, res) => {
      foreignDeliveries++;
      res.end('{}');
    });
    const foreignURL = await listen(foreign);
    const subjects: string[] = [];
    let redirect = false;
    let revoked = false;
    let hold = false;
    let arrived!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const server = createServer(async (req, res) => {
      const bearer = req.headers.authorization?.slice(7) ?? '';
      const account = JSON.parse(
        Buffer.from(bearer.split('.')[1] ?? '', 'base64url').toString(),
      ).userId;
      subjects.push(account);
      for await (const _part of req) {
        /* Consume the actual multipart or JSON body. */
      }
      if (hold) {
        arrived();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      if (redirect) {
        res.writeHead(302, { location: foreignURL });
        return res.end();
      }
      res.setHeader('content-type', 'application/json');
      if (revoked) {
        res.statusCode = 403;
        return res.end('{"error":{"message":"revoked"}}');
      }
      res.end(
        JSON.stringify(
          req.url?.endsWith('/transcriptions')
            ? { text: account }
            : { audioUrl: `https://media.test/${account}` },
        ),
      );
    });
    const baseURL = await listen(server);
    const oxy = new OxyServices({ baseURL });
    oxy.session.setAccessToken(token('A'));
    const linked = oxy.createLinkedClient({ baseURL });
    const speech = () =>
      requestSpeechClip({
        apiUrl: baseURL,
        transport: linked,
        input: 'Hello',
        voice: 'female',
        signal: new AbortController().signal,
      });
    try {
      expect(await speech()).toBe('https://media.test/A');
      expect(
        await requestTranscription({
          apiUrl: baseURL,
          transport: linked,
          clip: {
            file: new Blob(['audio'], { type: 'audio/webm' }),
            mediaType: 'audio/webm',
            durationMs: 20,
          },
          language: 'en',
        }),
      ).toMatchObject({ text: 'A' });
      hold = true;
      const pending = speech();
      const rejected = expect(pending).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
      await waiting;
      oxy.session.setAccessToken(token('B'));
      hold = false;
      release();
      await rejected;
      expect(await speech()).toBe('https://media.test/B');
      revoked = true;
      await expect(speech()).rejects.toMatchObject({ status: 403 });
      revoked = false;
      redirect = true;
      await expect(speech()).rejects.toBeDefined();
      await expect(
        requestSpeechClip({
          apiUrl: baseURL,
          token: token('external'),
          input: 'Hello',
          voice: 'female',
          signal: new AbortController().signal,
        }),
      ).rejects.toBeDefined();
      expect(foreignDeliveries).toBe(0);
      expect(subjects).toEqual(['A', 'A', 'A', 'B', 'B', 'B', 'external']);
    } finally {
      release?.();
      linked.dispose();
      oxy.dispose();
      for (const current of [server, foreign]) {
        current.closeAllConnections();
        await new Promise<void>((resolve) => current.close(() => resolve()));
      }
    }
  });

  it('pins WebSocket identity with core epochs, permits rotation and invalidates account/operator changes', () => {
    const oxy = new OxyServices({ baseURL: 'https://api.oxy.test' });
    oxy.session.setAccessToken(token('A'));
    const invalidated = vi.fn();
    const binding = bindAudioSession(oxy, 'https://api.alia.test', invalidated);
    try {
      oxy.session.setAccessToken(token('A', 1));
      expect(binding.getToken()).toBe(token('A', 1));
      expect(invalidated).not.toHaveBeenCalled();
      oxy.session.setAccessToken(token('A', 2, 'another-operator'));
      expect(binding.getToken()).toBeNull();
      expect(invalidated).toHaveBeenCalledTimes(1);
      binding.dispose();
      oxy.session.setAccessToken(token('B'));
      expect(invalidated).toHaveBeenCalledTimes(1);
      expect(binding.getToken()).toBeNull();
    } finally {
      binding.dispose();
      oxy.dispose();
    }
  });
});

it('aborts response-body consumption if the audio session changes after headers arrive', async () => {
  let arrived!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const server = createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"audioUrl":"');
    arrived();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    res.end('https://media.test/A"}');
  });
  const baseURL = await listen(server);
  const oxy = new OxyServices({ baseURL });
  oxy.session.setAccessToken(token('A'));
  const controller = new AbortController();
  const binding = bindAudioSession(oxy, baseURL, () => controller.abort());
  try {
    const pending = requestSpeechClip({
      apiUrl: baseURL,
      transport: binding,
      input: 'Hello',
      voice: 'female',
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toBeDefined();
    await waiting;
    oxy.session.setAccessToken(token('B'));
    await rejected;
    expect(controller.signal.aborted).toBe(true);
  } finally {
    release?.();
    binding.dispose();
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
