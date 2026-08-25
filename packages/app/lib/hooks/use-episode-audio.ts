/**
 * Playing one episode, from Syra.
 *
 * This owns the imperative half of playback — the player object, the token, the
 * cleanup — so the episode row can own the visible half. Syra's `EpisodeRow`
 * makes the same split for the same reason: the control's icon and its action
 * can never disagree if one thing decides both.
 *
 * ## Why `/audio` and not `/stream`
 *
 * `GET /api/podcasts/episodes/:id/stream` returns a tokenized HLS manifest, and
 * it cannot serve the case this exists for. A series defaults to PRIVATE, and
 * Syra does not transcode a private show — its own words, at
 * `services/podcasts/ingestEpisode.ts`: *"a private show's episodes stay on the
 * progressive `/audio` path, which is checked per request against the show's
 * current visibility."* So `/stream` answers `409 Episode processing` or
 * `422 Episode has no HLS stream` for exactly the episode a user just made.
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
 * `/audio` is a progressive MP3, checked per request against the show's CURRENT
 * visibility, and it is the enclosure Syra itself publishes in the RSS feed.
 *
 * ## The bearer token travels with the media request
 *
 * A private episode is owner-only, so the request has to carry the caller's Oxy
 * token. `expo-audio` takes `{ uri, headers }`, and on web its implementation is
 * `fetch(uri, { headers })` into a blob URL — so one call site covers native and
 * web rather than two.
 *
 * On web this needs Syra's CORS to allow Alia's origin. That is a Syra
 * deployment setting (`ALLOWED_ORIGINS`), not something this can arrange, and a
 * failure surfaces as `unplayable` rather than silently.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOxy } from '@oxyhq/services';
import { SYRA_API_URL } from '@/lib/config';

export type EpisodeAudioState = 'idle' | 'loading' | 'playing' | 'paused' | 'unplayable';

export interface EpisodeAudio {
  state: EpisodeAudioState;
  /** Start, pause or resume — whichever the current state means. */
  toggle: () => void;
}

/**
 * @param syraEpisodeId Syra's id, or `null` while the episode has none yet — in
 * which case nothing is playable and `toggle` does nothing.
 */
export function useEpisodeAudio(syraEpisodeId: string | null | undefined): EpisodeAudio {
  const { oxyServices } = useOxy();
  const [state, setState] = useState<EpisodeAudioState>('idle');
  /**
   * `expo-audio`'s player object, kept in a ref because nothing renders from it
   * — the visible state is `state`, which is React state. A ref read in a
   * memoized position would be a stale read; this one is only ever touched from
   * event handlers and cleanup.
   */
  const playerRef = useRef<{ play: () => void; pause: () => void; remove: () => void } | null>(null);

  const release = useCallback(() => {
    try {
      playerRef.current?.remove();
    } catch {
      // The native side may already have released it; there is nothing to undo.
    }
    playerRef.current = null;
  }, []);

  const toggle = useCallback(() => {
    if (syraEpisodeId === null || syraEpisodeId === undefined || syraEpisodeId === '') return;

    if (state === 'playing') {
      playerRef.current?.pause();
      setState('paused');
      return;
    }

    if (state === 'paused' && playerRef.current) {
      playerRef.current.play();
      setState('playing');
      return;
    }

    release();
    setState('loading');

    // Read at play time, not at render: an access token is short-lived, and a
    // token captured when the screen mounted may have been refreshed since.
    const token = oxyServices.getAccessToken();
    if (!token) {
      setState('unplayable');
      return;
    }

    void (async () => {
      try {
        const { createAudioPlayer } = await import('expo-audio');
        const player = createAudioPlayer({
          uri: `${SYRA_API_URL}/api/podcasts/episodes/${syraEpisodeId}/audio`,
          headers: { Authorization: `Bearer ${token}` },
        });
        playerRef.current = player;

        player.addListener('playbackStatusUpdate', (status: { didJustFinish?: boolean }) => {
          if (status.didJustFinish) {
            release();
            setState('idle');
          }
        });

        player.play();
        setState('playing');
      } catch {
        // A 404 from Syra reads the same as a network failure here, and that is
        // right: both mean this episode cannot be played by this caller now.
        release();
        setState('unplayable');
      }
    })();
  }, [state, release, oxyServices, syraEpisodeId]);

  useEffect(() => release, [release]);

  return { state, toggle };
}
