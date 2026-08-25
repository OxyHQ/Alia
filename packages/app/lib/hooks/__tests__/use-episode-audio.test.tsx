import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Whether a private episode's audio request actually carries the listener's
 * token, and what a person is told when it will not play.
 *
 * The bug these exist for: `expo-audio`'s web player reads `source.headers`
 * NOWHERE — only `preloadAsync` does, and nothing called it. So the `<audio>`
 * element asked Syra for a private URL anonymously, Syra answered `404`, and the
 * browser turned that JSON body into
 * `NotSupportedError: Failed to load because no supported source was found`.
 * It worked on a device the whole time.
 *
 * A test that asserted "a player was created" passed throughout that. These
 * assert the REQUEST, and that a refusal never reaches the player at all.
 */

const env = vi.hoisted(() => ({
  platform: 'web' as 'web' | 'ios',
  token: 'oxy-access-token' as string | null,
}));

interface PlaybackUpdate {
  didJustFinish?: boolean;
  error?: string | null;
}

interface FakePlayer {
  source: { uri: string; headers?: Record<string, string> };
  emit: (update: PlaybackUpdate) => void;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

const players = vi.hoisted(() => ({ created: [] as unknown[] }));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return env.platform;
    },
    select: (choices: Record<string, unknown>) => choices[env.platform] ?? choices.default,
  },
}));

vi.mock('@oxyhq/services', () => ({
  useOxy: () => ({ oxyServices: { getAccessToken: () => env.token } }),
}));

vi.mock('expo-audio', () => ({
  createAudioPlayer: (source: { uri: string; headers?: Record<string, string> }) => {
    const listeners: Array<(update: PlaybackUpdate) => void> = [];
    const player: FakePlayer = {
      source,
      emit: (update) => listeners.forEach((listener) => listener(update)),
      play: vi.fn(),
      pause: vi.fn(),
      remove: vi.fn(),
    };
    Object.assign(player, {
      addListener: (_event: string, listener: (update: PlaybackUpdate) => void) => {
        listeners.push(listener);
      },
    });
    players.created.push(player);
    return player;
  },
}));

import { useEpisodeAudio, type EpisodeAudio } from '../use-episode-audio';
import { SYRA_API_URL } from '@/lib/config';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const EPISODE_ID = 'syra-ep-3';
const AUDIO_URL = `${SYRA_API_URL}/api/podcasts/episodes/${EPISODE_ID}/audio`;

const created = () => players.created as FakePlayer[];

/**
 * What the hook actually reads off a response. `mp3()` and `refusal()` below
 * return REAL `Response` objects, which satisfy this structurally; only
 * {@link deferredMp3} — which has to hold the body open on purpose — is built by
 * hand, and typing the mock this way is what lets it be, without asserting a
 * partial object into a `Response` it is not.
 */
type AudioResponse = Pick<Response, 'ok' | 'status' | 'blob'>;

const fetchMock =
  vi.fn<(input: string, init?: { headers?: Record<string, string> }) => Promise<AudioResponse>>();

let objectUrlCount = 0;
const createObjectURL = vi.fn(() => `blob:alia/${objectUrlCount++}`);
const revokeObjectURL = vi.fn<(url: string) => void>();

let latest: EpisodeAudio | null = null;
let renderer: ReactTestRenderer | null = null;

function Probe({ episodeId }: { episodeId: string | null }) {
  latest = useEpisodeAudio(episodeId);
  return null;
}

function audio(): EpisodeAudio {
  if (latest === null) throw new Error('useEpisodeAudio never rendered');
  return latest;
}

function mount(episodeId: string | null = EPISODE_ID) {
  act(() => {
    renderer = create(<Probe episodeId={episodeId} />);
  });
}

/** Drain the microtask queue the async play path runs on. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function press() {
  act(() => audio().toggle());
  await settle();
}

/** A real `Response`, so `ok`, `status` and `blob()` behave as a browser's would. */
function mp3(bytes = 3): Response {
  return new Response(new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' }), { status: 200 });
}

/**
 * A response whose STATUS has arrived and whose BODY has not — a 15 MB MP3 over
 * a real connection, which is seconds during which a listener can navigate away.
 */
function deferredMp3(): { response: AudioResponse; deliver: () => void } {
  let deliver: () => void = () => {};
  const arrival = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  const bytes = new Blob([new Uint8Array(3)], { type: 'audio/mpeg' });
  return {
    response: {
      ok: true,
      status: 200,
      blob: async () => {
        await arrival;
        return bytes;
      },
    },
    deliver,
  };
}

function refusal(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  env.platform = 'web';
  env.token = 'oxy-access-token';
  players.created.length = 0;
  objectUrlCount = 0;
  latest = null;
  fetchMock.mockReset();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectURL);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectURL);
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useEpisodeAudio on the web', () => {
  it('asks Syra for the audio with the listener’s bearer token attached', async () => {
    fetchMock.mockImplementation(async () => mp3());
    mount();
    await press();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(AUDIO_URL);
    expect(init?.headers).toEqual({ Authorization: 'Bearer oxy-access-token' });
  });

  it('hands the player the fetched bytes, never the URL the browser would fetch anonymously', async () => {
    fetchMock.mockImplementation(async () => mp3());
    mount();
    await press();

    expect(created()).toHaveLength(1);
    expect(created()[0].source).toEqual({ uri: 'blob:alia/0' });
    // The whole failure in one assertion: an `<audio>` given this URL sends no
    // `Authorization`, whatever `headers` sat beside it.
    expect(created()[0].source.uri).not.toContain('syra');
    expect(created()[0].play).toHaveBeenCalledOnce();
    expect(audio().state).toBe('playing');
    expect(audio().problem).toBeNull();
  });

  it('reads the token at press time, so a refreshed one is the one that is sent', async () => {
    fetchMock.mockImplementation(async () => mp3());
    mount();
    env.token = 'refreshed-token';
    await press();

    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer refreshed-token' });
  });

  describe('a response that is not audio never becomes audio', () => {
    it('refuses a 404 rather than blobbing the JSON body', async () => {
      fetchMock.mockImplementation(async () => refusal(404, 'Episode not found'));
      mount();
      await press();

      // `preloadAsync` calls `response.blob()` with no `ok` check, which is how
      // a refusal reached the element and came back as `NotSupportedError`.
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(created()).toHaveLength(0);
      expect(audio().state).toBe('unplayable');
      expect(audio().problem).toBe('missing');
    });

    it('calls a rejected token a sign-in problem, not a missing episode', async () => {
      fetchMock.mockImplementation(async () => refusal(401, 'Unauthorized'));
      mount();
      await press();

      expect(created()).toHaveLength(0);
      expect(audio().problem).toBe('forbidden');
    });

    it('calls a 403 the same thing', async () => {
      fetchMock.mockImplementation(async () => refusal(403, 'Forbidden'));
      mount();
      await press();

      expect(audio().problem).toBe('forbidden');
    });

    it('calls anything else Syra answers unavailable', async () => {
      fetchMock.mockImplementation(async () => refusal(502, 'Upstream audio unavailable'));
      mount();
      await press();

      expect(created()).toHaveLength(0);
      expect(audio().problem).toBe('unavailable');
    });

    it('refuses a 200 with no bytes, which decodes exactly as badly as a 404 does', async () => {
      fetchMock.mockImplementation(async () => mp3(0));
      mount();
      await press();

      expect(created()).toHaveLength(0);
      expect(audio().problem).toBe('unavailable');
    });

    it('says the request never got an answer when the fetch itself rejects', async () => {
      // Offline, DNS, or a preflight from an origin Syra does not list — a
      // developer on `localhost` is the case that happens.
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      mount();
      await press();

      expect(created()).toHaveLength(0);
      expect(audio().state).toBe('unplayable');
      expect(audio().problem).toBe('unreachable');
    });
  });

  describe('the object URL lives for one playback', () => {
    it('is revoked when the episode finishes', async () => {
      fetchMock.mockImplementation(async () => mp3());
      mount();
      await press();
      expect(revokeObjectURL).not.toHaveBeenCalled();

      act(() => created()[0].emit({ didJustFinish: true }));

      expect(revokeObjectURL).toHaveBeenCalledWith('blob:alia/0');
      expect(created()[0].remove).toHaveBeenCalledOnce();
      expect(audio().state).toBe('idle');
    });

    it('is revoked when the row unmounts mid-listen', async () => {
      fetchMock.mockImplementation(async () => mp3());
      mount();
      await press();

      act(() => renderer?.unmount());
      renderer = null;

      expect(revokeObjectURL).toHaveBeenCalledWith('blob:alia/0');
    });

    it('is revoked when a second press replaces it', async () => {
      fetchMock.mockImplementation(async () => mp3());
      mount();
      await press();
      act(() => audio().toggle()); // pause
      act(() => audio().toggle()); // resume, same player
      expect(revokeObjectURL).not.toHaveBeenCalled();

      act(() => created()[0].emit({ didJustFinish: true }));
      revokeObjectURL.mockClear();
      await press();
      expect(created()).toHaveLength(2);

      act(() => created()[1].emit({ didJustFinish: true }));
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:alia/1');
    });

    it('allocates nothing when the listener leaves while the BODY is still arriving', async () => {
      // The status came back fine and the bytes are still on the wire, which is
      // where an unmount most plausibly lands. An attempt that only checked
      // staleness before reading the body would blob it, mint an object URL and
      // hand it to a player that nothing owns — and that URL pins the whole MP3
      // in memory for the life of the tab, because only a `release` that has
      // already run ever revokes one.
      const { response, deliver } = deferredMp3();
      fetchMock.mockResolvedValue(response);
      mount();
      act(() => audio().toggle());
      await settle();

      act(() => renderer?.unmount());
      renderer = null;
      deliver();
      await settle();

      expect(createObjectURL).not.toHaveBeenCalled();
      expect(created()).toHaveLength(0);
    });

    it('stops the download when the listener leaves before the response arrives', async () => {
      // Reading the body IS the download. An attempt that only noticed it was
      // stale afterwards would pull the whole MP3 over the wire and throw it
      // away — on a phone that is somebody's data.
      const readBody = vi.fn(async () => new Blob([new Uint8Array(3)], { type: 'audio/mpeg' }));
      let answer: (response: AudioResponse) => void = () => {};
      fetchMock.mockReturnValue(
        new Promise<AudioResponse>((resolve) => {
          answer = resolve;
        }),
      );
      mount();
      act(() => audio().toggle());

      act(() => renderer?.unmount());
      renderer = null;
      answer({ ok: true, status: 200, blob: readBody });
      await settle();

      expect(readBody).not.toHaveBeenCalled();
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(created()).toHaveLength(0);
    });
  });
});

describe('useEpisodeAudio on native', () => {
  beforeEach(() => {
    env.platform = 'ios';
  });

  it('passes the token as headers on the source, and fetches nothing itself', async () => {
    mount();
    await press();

    // Native reads `headers` and sends them, so the bytes stream from the real
    // URL rather than being buffered whole into memory.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(created()).toHaveLength(1);
    expect(created()[0].source).toEqual({
      uri: AUDIO_URL,
      headers: { Authorization: 'Bearer oxy-access-token' },
    });
    expect(audio().state).toBe('playing');
  });

  it('stops claiming to play when the player reports it could not load', async () => {
    mount();
    await press();
    expect(audio().state).toBe('playing');

    act(() => created()[0].emit({ error: 'The AVPlayerItem failed to load' }));

    expect(audio().state).toBe('unplayable');
    expect(audio().problem).toBe('unavailable');
    expect(created()[0].remove).toHaveBeenCalledOnce();
  });
});

describe('useEpisodeAudio before any request', () => {
  it('says to sign in, and asks Syra for nothing, when there is no token', async () => {
    env.token = null;
    mount();
    await press();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(created()).toHaveLength(0);
    expect(audio().state).toBe('unplayable');
    expect(audio().problem).toBe('signed-out');
  });

  it('does nothing at all for an episode Syra has no id for', async () => {
    mount(null);
    await press();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(created()).toHaveLength(0);
    expect(audio().state).toBe('idle');
    expect(audio().problem).toBeNull();
  });

  it('stops showing the previous refusal the moment a retry starts', async () => {
    // The row draws a spinner while `loading`. A refusal left over from the last
    // attempt sitting beside it describes nothing that is happening now.
    fetchMock.mockImplementationOnce(async () => refusal(404, 'Episode not found'));
    mount();
    await press();
    expect(audio().problem).toBe('missing');

    let answer: (response: AudioResponse) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise<AudioResponse>((resolve) => {
        answer = resolve;
      }),
    );
    act(() => audio().toggle());

    expect(audio().state).toBe('loading');
    expect(audio().problem).toBeNull();

    answer(mp3());
    await settle();
    expect(audio().state).toBe('playing');
  });

  it('clears the previous refusal when the next press succeeds', async () => {
    // The positive control for every `problem` assertion above: a hook that
    // never cleared would report `missing` forever and still satisfy them.
    fetchMock.mockResolvedValueOnce(refusal(404, 'Episode not found'));
    mount();
    await press();
    expect(audio().problem).toBe('missing');

    fetchMock.mockResolvedValueOnce(mp3());
    await press();

    expect(audio().state).toBe('playing');
    expect(audio().problem).toBeNull();
  });
});
