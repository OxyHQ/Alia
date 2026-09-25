import { EventEmitter } from 'node:events';
import { OxyInferenceError } from '@oxy.so/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ synthesizeSpeech: vi.fn(), upload: vi.fn(), remove: vi.fn(), find: vi.fn(), save: vi.fn(), link: vi.fn() }));
vi.mock('../../../lib/synthesize-speech.js', () => ({ synthesizeSpeech: H.synthesizeSpeech }));
vi.mock('../../../lib/s3.js', () => ({ uploadToS3: H.upload, deleteS3Objects: H.remove }));
vi.mock('../../../lib/stored-media.js', () => ({ storedMediaUrl: H.link }));
vi.mock('../../../db/chat/messageRepository.js', () => ({ findMessageAudioUrl: H.find, setMessageAudioUrl: H.save }));
vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../../db/notifications/audioJobRepository.js', () => ({ findAudioJobStatus: vi.fn() }));
vi.mock('../../../lib/logger.js', () => ({ log: { general: { error: vi.fn() } } }));
const { default: audioRouter } = await import('../audio.js');
interface RouteLayer { route?: { path?: string; methods?: Record<string, boolean>; stack: Array<{ handle: (req: unknown, res: unknown, next: unknown) => unknown }> } }
function handler() {
  const layer = (audioRouter as unknown as { stack: RouteLayer[] }).stack.find((entry) => entry.route?.path === '/speech' && entry.route.methods?.post);
  if (!layer?.route) throw new Error('Speech route missing');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function response() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200, body: undefined as unknown, writableEnded: false, headers: {} as Record<string,string>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; this.writableEnded = true; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; },
  });
}
const body = { input: 'Hola', voice: 'female', speed: 1.15, conversationId: 'c1', messageId: 'm1' };
beforeEach(() => {
  vi.clearAllMocks(); H.find.mockResolvedValue(null); H.save.mockResolvedValue(1);
  H.synthesizeSpeech.mockResolvedValue({ audio: Buffer.from('ID3'), format: 'mp3', requestId: 'req_tts' });
  H.upload.mockResolvedValue('test/audio/u1/speech.mp3'); H.remove.mockResolvedValue(1);
  H.link.mockReturnValue('https://api.alia.test/media?signed');
});
describe('speech synthesis boundary', () => {
  it('requires authentication before synthesis or storage', async () => {
    const res = response(); await handler()({ body }, res, undefined);
    expect(res.statusCode).toBe(401); expect(H.synthesizeSpeech).not.toHaveBeenCalled(); expect(H.upload).not.toHaveBeenCalled();
  });
  it('returns playable stored audio and only updates the authenticated user’s message', async () => {
    const res = response(); await handler()({ user: { id: 'u1' }, body }, res, undefined);
    expect(res.statusCode).toBe(200); expect(res.body).toEqual({ audioUrl: 'https://api.alia.test/media?signed', requestId: 'req_tts' });
    expect(H.synthesizeSpeech).toHaveBeenCalledWith({ input: 'Hola', voice: 'female', format: 'mp3', userId: 'u1', speed: 1.15, signal: expect.any(AbortSignal) });
    expect(H.save).toHaveBeenCalledWith({}, 'u1', 'c1', 'm1', 'test/audio/u1/speech.mp3');
    expect(H.remove).not.toHaveBeenCalled(); expect(res.listenerCount('close')).toBe(0);
  });
  it.each([{ input: '' }, { input: ' '.repeat(4) }, { input: 'a'.repeat(15001) }, { voice: 'unknown' }, { speed: 4 }, { model: 42 }, { extra: true }])('rejects unsupported input before egress: %p', async (patch) => {
    const res = response(); await handler()({ user: { id: 'u1' }, body: { ...body, ...patch } }, res, undefined);
    expect(res.statusCode).toBe(400); expect(H.synthesizeSpeech).not.toHaveBeenCalled();
  });
  it('ignores a model an older client still names: the speech model is the catalogue\'s', async () => {
    const res = response(); await handler()({ user: { id: 'u1' }, body: { ...body, model: 'acme/any' } }, res, undefined);
    expect(res.statusCode).toBe(200);
    expect(H.synthesizeSpeech).toHaveBeenCalledWith(expect.not.objectContaining({ model: expect.anything() }));
  });
  it('does not generate audio for another user’s message', async () => {
    H.find.mockResolvedValue(undefined); const res = response();
    await handler()({ user: { id: 'u1' }, body }, res, undefined);
    expect(res.statusCode).toBe(404); expect(H.synthesizeSpeech).not.toHaveBeenCalled();
  });
  it('preserves provider rate limits and never retries a paid request', async () => {
    H.synthesizeSpeech.mockRejectedValue(new OxyInferenceError({ status: 429, code: 'rate_limited', message: 'Capacity unavailable', requestId: 'req_limit', retryable: true, retryAfterMs: 1500 }));
    const res = response(); await handler()({ user: { id: 'u1' }, body }, res, undefined);
    expect(res.statusCode).toBe(429); expect(res.headers['Retry-After']).toBe('2');
    expect(res.body).toMatchObject({ error: { code: 'rate_limited', requestId: 'req_limit', retryAfterMs: 1500 } });
    expect(H.synthesizeSpeech).toHaveBeenCalledTimes(1); expect(H.upload).not.toHaveBeenCalled();
  });
  it('removes generated storage when the message disappears before attachment', async () => {
    H.save.mockResolvedValue(0); const res = response(); await handler()({ user: { id: 'u1' }, body }, res, undefined);
    expect(res.statusCode).toBe(502); expect(H.remove).toHaveBeenCalledWith(['test/audio/u1/speech.mp3']);
  });
  it('cancels synthesis when its client disconnects', async () => {
    const res = response();
    H.synthesizeSpeech.mockImplementation(async (options) => { res.emit('close'); options.signal.throwIfAborted(); });
    await handler()({ user: { id: 'u1' }, body }, res, undefined);
    expect(H.upload).not.toHaveBeenCalled(); expect(res.body).toBeUndefined(); expect(res.listenerCount('close')).toBe(0);
  });
});
