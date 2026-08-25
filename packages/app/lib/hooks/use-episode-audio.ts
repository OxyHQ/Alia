/**
 * Playing one episode, from Syra.
 *
 * This owns the imperative half of playback — the player object, the token, the
 * bytes, the cleanup — so the episode row can own the visible half. Syra's
 * `EpisodeRow` makes the same split for the same reason: the control's icon and
 * its action can never disagree if one thing decides both.
 *
 * ## Why `/audio` and not `/stream`
 *
 * `GET /api/podcasts/episodes/:id/stream` returns a tokenized HLS manifest, and
 * it cannot serve the case this exists for. A series defaults to PRIVATE, and
 * Syra does not transcode a private show — so `/stream` answers
 * `409 Episode processing` or `422 Episode has no HLS stream` for exactly the
 * episode a user just made.
 *
 * That is also why a private episode sits at `processing` in Syra's own studio
 * forever: it is that episode's CORRECT final state, not a job still running.
 * Alia never surfaces Syra's status — an episode Alia finished is ready here,
 * and it plays.
 *
 * Two more reasons `/stream` would be the wrong choice even for a public show:
 * an HLS manifest needs hls.js on Chrome and Firefox, and there is a window
 * between ingest and the transcode finishing where `/stream` 409s while
 * `/audio` already works.
 *
 * `/audio` is a progressive MP3 and it is the enclosure Syra itself publishes in
 * the RSS feed. Syra gates it on the SHOW's audience, never on who is asking:
 * `public` and `unlisted` are anonymous by design, because Apple Podcasts and
 * Overcast fetch that same URL with no credentials. Only `private` asks, and the
 * only answer it takes is the owner — anyone else gets `404`, deliberately
 * indistinguishable from an id that names nothing
 * (`controllers/stream.controller.ts`, `requestMayReachShowMedia`).
 *
 * ## The bearer token, and the one thing `expo-audio` does not do with it
 *
 * A private show's episode is owner-only, so the request has to carry the
 * caller's Oxy token.
 *
 * On NATIVE that is `createAudioPlayer({ uri, headers })` and the headers are
 * sent. On WEB they are silently dropped, and this is measured, not inferred, in
 * `expo-audio@57.0.0`:
 *
 * - `AudioModule.web.ts` `preloadAsync()` is the ONLY web function that reads
 *   `source.headers`. It fetches the URI with them and stores a blob URL in
 *   `preloadCache`.
 * - `AudioPlayer.web.ts` `_createMediaElement()` does `new Audio(cachedUri)`,
 *   where `cachedUri` is that blob only if `preloadCache.has(uri)` — otherwise
 *   it is the raw URI, and `headers` is never looked at again.
 *
 * Nothing here called `preloadAsync`, so the `<audio>` element requested a
 * private URL anonymously, Syra answered `404`, and the browser reported
 * `NotSupportedError: Failed to load because no supported source was found` —
 * an error that names the symptom and hides the cause. It worked on a device
 * and failed in a browser, which is why it reached an owner.
 *
 * So on web this owns the fetch instead. Not through `preloadAsync`, for two
 * reasons: its cache is keyed by URI and lives for the tab, and it calls
 * `response.blob()` with no `response.ok` check — a `404` JSON body would become
 * "the audio", which is how this failure became `NotSupportedError` rather than
 * a sentence a person can act on. Owning it means the status is read BEFORE the
 * bytes are called audio, and every refusal gets its own words — the five of
 * them live in `components/show/episode-row.tsx`, beside the line that renders
 * them, and a `Record<EpisodeAudioProblem, string>` is what stops a sixth being
 * added here without any.
 *
 * One module and one call site, with an explicit `Platform.OS` branch, rather
 * than two platform files: the state machine, the failure vocabulary and the
 * release path are the same on both, and only the four lines that turn a URL
 * into a playable source differ. A fork would duplicate the rest, and a test of
 * the forked half could not prove the hook calls it.
 *
 * ## What web pays for it
 *
 * The whole MP3 is downloaded before the first sample plays, and no `Range`
 * request is possible — a header-authenticated media element has no other shape.
 * The object URL is revoked in {@link release}, so it lives for one playback and
 * not for the tab; pressing play again re-requests, which Syra's own
 * `Cache-Control: public, max-age=3600` serves from the browser cache.
 *
 * ## CORS
 *
 * `Authorization` is not a CORS-safelisted header, so this fetch is preflighted
 * and Syra must list Alia's exact origin. `https://alia.onl` is listed (Syra
 * `packages/backend/server.ts`, `ALLOWED_ORIGINS`). No local origin is —
 * neither `http://localhost:8150` nor the tunnel host `dev:app` hands out — and
 * Syra's origin callback answers `false` rather than an error, so the preflight
 * comes back without `Access-Control-Allow-Origin` and the fetch rejects. That
 * surfaces as `unreachable`, which is the truth from here: the request never got
 * an answer. Native sends no `Origin` and is not subject to any of it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useOxy } from '@oxyhq/services';
import { SYRA_API_URL } from '@/lib/config';

export type EpisodeAudioState = 'idle' | 'loading' | 'playing' | 'paused' | 'unplayable';

/**
 * The part of `expo-audio`'s player this uses. Named structurally rather than
 * imported, because the module is loaded lazily and a type-only import of it
 * would be the one thing pulling it into the bundle at parse time.
 */
interface AudioPlayer {
  play: () => void;
  pause: () => void;
  remove: () => void;
  addListener: (
    event: 'playbackStatusUpdate',
    listener: (playback: { didJustFinish?: boolean; error?: string | null }) => void,
  ) => void;
}

/**
 * Why an episode will not play, at the resolution the client can actually
 * justify.
 *
 * `missing` is `404`, which Syra uses for a private show a caller does not own
 * AND for an episode it holds no audio for — on purpose, so a private episode is
 * indistinguishable from a made-up id. That conflation costs nothing here: the
 * play control only exists for an episode Alia itself finished and whose owner
 * is looking at it, so a `404` means Syra does not have the recording Alia
 * believes it published, and the words say exactly that.
 */
export type EpisodeAudioProblem =
  | 'signed-out'
  | 'forbidden'
  | 'missing'
  | 'unavailable'
  | 'unreachable';

export interface EpisodeAudio {
  state: EpisodeAudioState;
  /** Set only while `state` is `unplayable`, and never stale: they move together. */
  problem: EpisodeAudioProblem | null;
  /** Start, pause or resume — whichever the current state means. */
  toggle: () => void;
}

/** The state and its reason are one fact, so nothing can render half of it. */
interface EpisodeAudioStatus {
  readonly state: EpisodeAudioState;
  readonly problem: EpisodeAudioProblem | null;
}

const IDLE: EpisodeAudioStatus = { state: 'idle', problem: null };

/**
 * @param syraEpisodeId Syra's id, or `null` while the episode has none yet — in
 * which case nothing is playable and `toggle` does nothing.
 */
export function useEpisodeAudio(syraEpisodeId: string | null | undefined): EpisodeAudio {
  const { oxyServices } = useOxy();
  const [status, setStatus] = useState<EpisodeAudioStatus>(IDLE);
  /**
   * `expo-audio`'s player object, kept in a ref because nothing renders from it
   * — the visible state is `status`, which is React state. A ref read in a
   * memoized position would be a stale read; this one is only ever touched from
   * event handlers and cleanup.
   */
  const playerRef = useRef<AudioPlayer | null>(null);
  /** The web object URL currently being played, so `release` can revoke exactly it. */
  const objectUrlRef = useRef<string | null>(null);
  /**
   * Which attempt is current. A press, an unmount or a finish all invalidate any
   * fetch still in flight; without this, a request started before an unmount
   * would still create a player and an object URL nothing would ever revoke,
   * holding the whole MP3 for the life of the tab.
   */
  const attemptRef = useRef(0);

  const release = useCallback(() => {
    attemptRef.current += 1;

    try {
      playerRef.current?.remove();
    } catch {
      // The native side may already have released it; there is nothing to undo.
    }
    playerRef.current = null;

    const objectUrl = objectUrlRef.current;
    objectUrlRef.current = null;
    if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
  }, []);

  const toggle = useCallback(() => {
    if (syraEpisodeId === null || syraEpisodeId === undefined || syraEpisodeId === '') return;

    if (status.state === 'playing') {
      playerRef.current?.pause();
      setStatus({ state: 'paused', problem: null });
      return;
    }

    if (status.state === 'paused' && playerRef.current) {
      playerRef.current.play();
      setStatus({ state: 'playing', problem: null });
      return;
    }

    release();
    const attempt = attemptRef.current;
    setStatus({ state: 'loading', problem: null });

    // Read at play time, not at render: an access token is short-lived, and a
    // token captured when the screen mounted may have been refreshed since.
    const token = oxyServices.getAccessToken();
    if (!token) {
      setStatus({ state: 'unplayable', problem: 'signed-out' });
      return;
    }

    const url = `${SYRA_API_URL}/api/podcasts/episodes/${syraEpisodeId}/audio`;
    const authorization = `Bearer ${token}`;

    void (async () => {
      /** Nothing this attempt does may touch state or the refs once it is stale. */
      const superseded = () => attemptRef.current !== attempt;
      const fail = (problem: EpisodeAudioProblem) => {
        if (!superseded()) setStatus({ state: 'unplayable', problem });
      };

      // Loaded before the bytes are asked for, so a player that cannot be built
      // does not cost a listener a download first. `expo-audio` is imported
      // lazily so it stays out of the bundle a first paint needs.
      let createAudioPlayer: (source: {
        uri: string;
        headers?: Record<string, string>;
      }) => AudioPlayer;
      try {
        ({ createAudioPlayer } = await import('expo-audio'));
      } catch {
        fail('unavailable');
        return;
      }

      /** The web's downloaded audio, and `null` on native, which streams it. */
      let bytes: Blob | null = null;

      if (Platform.OS === 'web') {
        let response: Response;
        try {
          response = await fetch(url, { headers: { Authorization: authorization } });
        } catch {
          // Rejected, not answered: offline, DNS, or a preflight this origin is
          // not in Syra's allow-list for.
          fail('unreachable');
          return;
        }
        // Before the body, so an abandoned press stops the download rather than
        // finishing an MP3 nobody is waiting for and discarding it.
        if (superseded()) return;

        if (!response.ok) {
          // Read BEFORE the body. `preloadAsync` blobs the response either way,
          // which is how a refusal became "audio the browser cannot decode".
          fail(
            response.status === 401 || response.status === 403
              ? 'forbidden'
              : response.status === 404
                ? 'missing'
                : 'unavailable',
          );
          return;
        }

        try {
          bytes = await response.blob();
        } catch {
          // The status said yes and the bytes never arrived.
          fail('unreachable');
          return;
        }

        // A zero-byte 200 is the other way this reaches the element as
        // `NotSupportedError`, and it is not audio either.
        if (bytes.size === 0) {
          fail('unavailable');
          return;
        }
      }

      // Every `await` is behind us, and nothing above allocated anything. This
      // is the one staleness check that matters: below it are an object URL and
      // a player, and the only thing that ever frees either is a `release` that
      // has already run.
      if (superseded()) return;

      let source: { uri: string; headers?: Record<string, string> };
      if (bytes === null) {
        // Native reads `headers` and sends them, so the URL stays the real one
        // and the bytes stream instead of being buffered whole.
        source = { uri: url, headers: { Authorization: authorization } };
      } else {
        const objectUrl = URL.createObjectURL(bytes);
        objectUrlRef.current = objectUrl;
        source = { uri: objectUrl };
      }

      try {
        const player = createAudioPlayer(source);
        playerRef.current = player;

        player.addListener(
          'playbackStatusUpdate',
          (playback: { didJustFinish?: boolean; error?: string | null }) => {
            // The player's own load failure. Native cannot be pre-checked the way
            // the web fetch is, so this is where a source that will not decode
            // stops claiming to be playing.
            if (typeof playback.error === 'string' && playback.error !== '') {
              release();
              setStatus({ state: 'unplayable', problem: 'unavailable' });
              return;
            }
            if (playback.didJustFinish) {
              release();
              setStatus(IDLE);
            }
          },
        );

        player.play();
        setStatus({ state: 'playing', problem: null });
      } catch {
        // The player itself could not be built from a source that fetched fine.
        // Checked before `release`, which invalidates this attempt by design and
        // would otherwise make the failure unreportable.
        if (superseded()) return;
        release();
        setStatus({ state: 'unplayable', problem: 'unavailable' });
      }
    })();
  }, [status.state, release, oxyServices, syraEpisodeId]);

  useEffect(() => release, [release]);

  return { state: status.state, problem: status.problem, toggle };
}
