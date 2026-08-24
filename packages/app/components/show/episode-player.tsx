/**
 * Playing one episode, from Syra.
 *
 * ## Why `/audio` and not `/stream`
 *
 * `GET /api/podcasts/episodes/:id/stream` returns a tokenized HLS manifest, and
 * it cannot serve the case this screen exists for. A series defaults to
 * PRIVATE, and Syra does not transcode a private show — its own words, at
 * `services/podcasts/ingestEpisode.ts`: *"a private show's episodes stay on the
 * progressive `/audio` path, which is checked per request against the show's
 * current visibility."* So `/stream` answers `409 Episode processing` or
 * `422 Episode has no HLS stream` for exactly the episode a user just made.
 *
 * Two more reasons it would be the wrong choice even for a public show: an HLS
 * manifest needs hls.js on Chrome and Firefox, and there is a window between
 * ingest and the transcode finishing where `/stream` 409s while `/audio`
 * already works.
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
 * deployment setting (`ALLOWED_ORIGINS`), not something this component can
 * arrange, and a failure surfaces here as "could not play" rather than silently.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Play, Pause, Square } from 'lucide-react-native';
import { useOxy } from '@oxyhq/services';
import { SYRA_API_URL } from '@/lib/config';
import { cn } from '@/lib/utils';

interface EpisodePlayerProps {
  /** Syra's episode id. Absent means the episode has not been published yet. */
  syraEpisodeId: string;
  title: string;
  durationMs?: number | null;
}

type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'unplayable';

/** `1:05`, and `--:--` when nothing measured it. */
function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms <= 0) return '--:--';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function EpisodePlayer({ syraEpisodeId, title, durationMs }: EpisodePlayerProps) {
  const { oxyServices } = useOxy();
  const [state, setState] = useState<PlayerState>('idle');
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

  const handlePlayPause = useCallback(async () => {
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
  }, [state, release, oxyServices, syraEpisodeId]);

  const handleStop = useCallback(() => {
    release();
    setState('idle');
  }, [release]);

  useEffect(() => release, [release]);

  return (
    <View className="flex-row items-center gap-3 rounded-xl border border-border bg-card p-3">
      <Pressable
        onPress={handlePlayPause}
        disabled={state === 'loading'}
        accessibilityRole="button"
        accessibilityLabel={state === 'playing' ? `Pause ${title}` : `Play ${title}`}
        className={cn(
          'h-10 w-10 items-center justify-center rounded-full bg-primary active:opacity-80',
          state === 'loading' && 'opacity-60',
        )}
      >
        {state === 'loading' ? (
          <ActivityIndicator size="small" className="text-primary-foreground" />
        ) : state === 'playing' ? (
          <Pause size={18} className="text-primary-foreground" fill="currentColor" />
        ) : (
          <Play size={18} className="text-primary-foreground" fill="currentColor" />
        )}
      </Pressable>

      <View className="flex-1">
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {title}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {state === 'unplayable' ? 'Cannot be played right now' : formatDuration(durationMs)}
        </Text>
      </View>

      {(state === 'playing' || state === 'paused') && (
        <Pressable
          onPress={handleStop}
          accessibilityRole="button"
          accessibilityLabel="Stop"
          className="p-2 active:opacity-70"
        >
          <Square size={16} className="text-muted-foreground" fill="currentColor" />
        </Pressable>
      )}
    </View>
  );
}
