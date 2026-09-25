import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>(), create: vi.fn() }));
vi.mock('@oxy.so/services', () => ({ useOxy: () => ({ oxyServices: { httpService: { getAccessToken: () => 'test-session' } } }) }));
vi.mock('react-native-reanimated', () => ({ makeMutable: (value: number) => ({ value }), withTiming: (value: number) => value }));
vi.mock('expo-audio', () => ({ createAudioPlayer: mocks.create }));
import { useTTS } from '../../src/hooks/useTTS';

let latest: ReturnType<typeof useTTS>;
let renderer: TestRenderer.ReactTestRenderer;
function Harness() { latest = useTTS({ apiUrl: 'https://alia.test', voice: 'female' }); return null; }
function audioResponse(name: string) { return Response.json({ audioUrl: `https://alia.test/media/${name}` }); }
async function flushPlayback() { await act(async () => { await vi.waitFor(() => expect(mocks.create).toHaveBeenCalled()); }); }

describe('read-aloud request and playback lifecycle', () => {
  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.fetch.mockReset(); mocks.create.mockReset();
    mocks.create.mockImplementation(() => ({ play: vi.fn(), pause: vi.fn(), remove: vi.fn(), setAudioSamplingEnabled: vi.fn(), addListener: vi.fn() }));
    await act(async () => { renderer = TestRenderer.create(<Harness />); });
  });
  afterEach(async () => {
    await act(async () => { latest.stop(); renderer.unmount(); });
    vi.unstubAllGlobals(); vi.restoreAllMocks();
  });
  it('sends the product voice and plays the returned private link once', async () => {
    mocks.fetch.mockResolvedValue(audioResponse('one'));
    await act(async () => { await latest.readAloud('m1', 'Hola', 'c1'); });
    await flushPlayback();
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe('https://alia.test/v1/audio/speech');
    expect(JSON.parse(String(init?.body))).toEqual({ input: 'Hola', voice: 'female', speed: 1, conversationId: 'c1', messageId: 'm1' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.create).toHaveBeenCalledWith({ uri: 'https://alia.test/media/one' }, { crossOrigin: 'anonymous' });
    expect(mocks.create.mock.results[0].value.play).toHaveBeenCalledTimes(1);
    expect(latest.isPlaying).toBe(true);
  });
  it('stopping cancels pending synthesis and ignores a late response', async () => {
    let finish!: (response: Response) => void;
    mocks.fetch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    let pending!: Promise<void>;
    await act(async () => { pending = latest.readAloud('m1', 'Hola'); });
    const signal = mocks.fetch.mock.calls[0][1]?.signal;
    await act(async () => { latest.stop(); finish(audioResponse('late')); await pending; });
    expect(signal?.aborted).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(latest.playbackState).toBe('idle'); expect(latest.error).toBeNull();
  });
  it('switching messages cannot play an older request that completes later', async () => {
    let finish!: (response: Response) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce(audioResponse('new'));
    let previous!: Promise<void>;
    await act(async () => { previous = latest.readAloud('m1', 'Primero'); });
    await act(async () => { await latest.readAloud('m2', 'Segundo'); });
    await flushPlayback();
    await act(async () => { finish(audioResponse('old')); await previous; });
    expect(mocks.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0].uri).toBe('https://alia.test/media/new');
    expect(latest.activeMessageId).toBe('m2');
  });
  it('surfaces a 429 without starting playback or retrying synthesis', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.fetch.mockResolvedValue(Response.json({ error: { message: 'Please wait' } }, { status: 429 }));
    await act(async () => { await latest.readAloud('m1', 'Hola'); });
    expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(mocks.create).not.toHaveBeenCalled();
    expect(latest.error).toBe('Please wait');
  });
});
