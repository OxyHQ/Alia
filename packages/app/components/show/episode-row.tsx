/**
 * One episode, in the shape Syra gives an episode.
 *
 * Syra's own row (`packages/frontend/components/EpisodeRow.tsx`) is a title, a
 * quiet metadata line reading `date • duration`, and a circular play control at
 * the right edge — nothing else. That restraint is the point: a show page is a
 * list of things to listen to, not a list of records. Alia's row is rebuilt to
 * the same shape here rather than importing Syra's, because the two apps have
 * different design systems and a copied component drifts from both.
 *
 * ## The two states Syra does not have
 *
 * An episode Alia is still MAKING is not an episode Syra would ever show: it has
 * no audio, no duration and no Syra id yet. It reads as work in progress —
 * the right-hand slot holds a spinner where the play control sits, and the
 * pipeline's own step and percentage sit under the title.
 *
 * An episode that FAILED says so and shows why.
 *
 * Neither is Syra's `processing`, which a private show's episodes stay in
 * forever by design (Syra does not transcode a private show). Alia never reads
 * that status and must never imply it: an episode Alia finished is ready here,
 * and it plays. See `lib/hooks/use-episode-audio.ts`.
 */

import React, { useCallback } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { AlertCircle, Pause, Play, Trash2 } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { useEpisodeAudio } from '@/lib/hooks/use-episode-audio';
import { useColorScheme } from '@/lib/useColorScheme';
import {
  ACTIVE_EPISODE_STATUSES,
  useShowStore,
  type ShowEpisode,
  type ShowEpisodeStatus,
} from '@/lib/stores/show-store';
import {
  formatEpisodeDate,
  formatEpisodeDuration,
  joinEpisodeMeta,
} from '@/lib/utils/show-format';

/** What each production step is called while it is happening. */
const STEP_LABEL: Record<ShowEpisodeStatus, string> = {
  queued: 'Queued',
  generating_script: 'Writing the script',
  generating_audio: 'Recording',
  concatenating: 'Assembling',
  publishing: 'Publishing to Syra',
  completed: 'Ready',
  failed: 'Failed',
};

interface EpisodeRowProps {
  episode: ShowEpisode;
  onDelete: (episodeId: string) => void;
}

export function EpisodeRow({ episode, onDelete }: EpisodeRowProps) {
  const { colors } = useColorScheme();
  const { state, toggle } = useEpisodeAudio(episode.syraEpisodeId);
  /**
   * The step text and the segment counter exist only on the live event. The
   * status and the percentage are patched onto the episode itself by
   * `updateProgress`, so the bar below still draws after a reload, when no event
   * has arrived yet for an episode that was already in flight.
   */
  const live = useShowStore((s) => s.activeGenerations.get(episode.id));

  const isGenerating = ACTIVE_EPISODE_STATUSES.includes(episode.status);
  const isPlayable =
    episode.status === 'completed' &&
    episode.syraEpisodeId !== null &&
    episode.syraEpisodeId !== undefined;
  const isPlaying = state === 'playing';

  const handleDelete = useCallback(() => onDelete(episode.id), [onDelete, episode.id]);

  /**
   * What the episode asked for and did not get.
   *
   * Derived from the segments the row already carries rather than from a field
   * of its own, so there is one fact and not two. It exists because an episode
   * that lost every sound cue it wrote looked, here, exactly like one that kept
   * them — ready, playable, and silent about three missing effects nobody could
   * see outside the container's logs.
   *
   * Withheld while the episode is still being made: segments are marked as each
   * batch finishes, so a count shown then is a number that climbs, next to a
   * progress bar already saying the work is not done.
   */
  const missing = episode.segments?.filter((segment) => segment.renderFailed) ?? [];
  const missingEffects = missing.filter((segment) => segment.type !== 'dialogue').length;
  const missingLines = missing.length - missingEffects;
  const missingEffectsLabel =
    isGenerating || missingEffects === 0
      ? ''
      : missingEffects === 1
        ? '1 sound effect missing'
        : `${missingEffects} sound effects missing`;
  const missingLinesLabel =
    isGenerating || missingLines === 0
      ? ''
      : missingLines === 1
        ? '1 line missing'
        : `${missingLines} lines missing`;

  /**
   * `date · duration`, the way Syra states it, behind the episode number — which
   * Syra has no equivalent of, because a Syra episode arrives from a feed while
   * an Alia episode is the Nth one the owner asked for.
   *
   * An episode that will not play says so HERE, in the same quiet line as the
   * duration it is standing in for. It is a fact about this attempt, not a fault
   * report, and it never claims the episode is still being made. A cue that
   * could not be produced belongs in the same line for the same reason: the
   * recording IS the episode and it plays, so this states what is not in it
   * rather than raising an alarm about it.
   */
  const meta = joinEpisodeMeta([
    `Episode ${episode.episodeNumber}`,
    formatEpisodeDate(episode.createdAt),
    state === 'unplayable' ? "Couldn't play this one" : formatEpisodeDuration(episode.durationMs),
    episode.creditsCharged ? `${episode.creditsCharged} credits` : '',
    missingEffectsLabel,
    missingLinesLabel,
  ]);

  /** What the episode is about: its recap once written, its topic until then. */
  const summary = episode.recap?.trim() || episode.topic;

  return (
    <View className="group flex-row items-start gap-3 rounded-xl px-2 py-2.5 web:transition-colors web:hover:bg-muted/40">
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-[15px] font-semibold leading-5 text-foreground" numberOfLines={2}>
          {episode.title}
        </Text>

        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {meta}
        </Text>

        {summary ? (
          <Text className="text-xs leading-4 text-muted-foreground/80" numberOfLines={2}>
            {summary}
          </Text>
        ) : null}

        {isGenerating ? (
          <View className="gap-1 pt-1">
            <View className="h-[3px] overflow-hidden rounded-full bg-border">
              <View
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.max(2, Math.min(100, episode.progress))}%` }}
              />
            </View>
            <View className="flex-row items-center justify-between gap-2">
              <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
                {live?.currentStep || STEP_LABEL[episode.status]}
              </Text>
              {live?.segmentIndex !== undefined && live.totalSegments !== undefined ? (
                <Text className="text-[11px] text-muted-foreground">
                  Segment {live.segmentIndex}/{live.totalSegments}
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}

        {episode.status === 'failed' && episode.error ? (
          <View className="mt-1 rounded-lg bg-destructive/10 px-2 py-1.5">
            <Text className="text-xs text-destructive">{episode.error}</Text>
          </View>
        ) : null}
      </View>

      <Pressable
        onPress={handleDelete}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${episode.title}`}
        className="h-8 w-8 items-center justify-center rounded-full active:opacity-70 web:opacity-0 web:transition-opacity web:group-hover:opacity-100"
      >
        <Trash2 size={15} className="text-muted-foreground" />
      </Pressable>

      {/*
        The right edge is where the play control lives on Syra, so it is where
        an episode's readiness is legible: the control itself when there is
        something to hear, the work still happening when there is not.
      */}
      <View className="h-10 w-10 items-center justify-center">
        {isPlayable ? (
          <Pressable
            onPress={toggle}
            disabled={state === 'loading'}
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? `Pause ${episode.title}` : `Play ${episode.title}`}
            className="h-10 w-10 items-center justify-center rounded-full border border-border active:opacity-70 web:hover:bg-muted"
          >
            {state === 'loading' ? (
              <ActivityIndicator size="small" color={colors.foreground} />
            ) : isPlaying ? (
              <Pause size={18} className="text-foreground" fill="currentColor" />
            ) : (
              <Play size={18} className="text-foreground" fill="currentColor" />
            )}
          </Pressable>
        ) : isGenerating ? (
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        ) : episode.status === 'failed' ? (
          <AlertCircle size={18} className="text-destructive" />
        ) : null}
      </View>
    </View>
  );
}
