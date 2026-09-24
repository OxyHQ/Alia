import {
  useEpisodeAudio,
  type EpisodeAudioProblem,
} from '@/lib/hooks/use-episode-audio';
import {
  ACTIVE_EPISODE_STATUSES,
  episodeDisplayTitle,
  useShowStore,
  type ShowEpisode,
  type ShowEpisodeStatus,
} from '@/lib/stores/show-store';
import {
  formatEpisodeDate,
  formatEpisodeDuration,
  joinEpisodeMeta,
} from '@/lib/utils/show-format';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
import { RiPauseFill } from '@oxy.so/bloom/icons/RiPauseFill';
import { RiPlayFill } from '@oxy.so/bloom/icons/RiPlayFill';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { Meter } from '@oxy.so/bloom/stat-bar';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { useCallback } from 'react';
import { View } from 'react-native';
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










/**
 * What a listener reads when an episode will not play, one line each.
 *
 * All five replace a single `NotSupportedError` in the browser console, which
 * said nothing to the person holding the phone and named the symptom rather than
 * the cause. They live here, beside the line that renders them, because they are
 * the row's words; the hook owns only WHICH refusal happened. `Record` over the
 * union is what makes a sixth refusal impossible to add without words for it.
 */
export const EPISODE_AUDIO_PROBLEM_LABEL: Record<EpisodeAudioProblem, string> = {
  'signed-out': 'Sign in to play this',
  forbidden: 'Sign in again to play this',
  missing: 'Syra has no recording for this',
  unavailable: "This one wouldn't play",
  unreachable: "Couldn't reach Syra",
};

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
  const { colors } = useTheme();
  const { state, problem, toggle } = useEpisodeAudio(episode.syraEpisodeId);
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
   * An episode nobody named has NO name until its script writes one, so this
   * stands in until then. It is the number Syra's own draft is reserved under,
   * which is why the two never look like different episodes.
   */
  const name = episodeDisplayTitle(episode);

  /**
   * What the episode asked for and did not get.
   *
   * Derived from the segments the row already carries rather than from a field
   * of its own, so there is one fact and not two. It exists because an episode
   * that lost lines looked, here, exactly like one that kept them — ready,
   * playable, and silent about what nobody could see outside the container's
   * logs.
   *
   * Only spoken lines count. A legacy sound cue on an older episode (`sfx`,
   * `transition`) is not a line, and sound effects no longer exist, so its
   * failure is not something to report.
   *
   * Withheld while the episode is still being made: segments are marked as each
   * batch finishes, so a count shown then is a number that climbs, next to a
   * progress bar already saying the work is not done.
   */
  const missingLines =
    episode.segments?.filter(
      (segment) => segment.type === 'dialogue' && segment.renderFailed,
    ).length ?? 0;
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
   * report, and it never claims the episode is still being made. It says WHICH
   * refusal, because "couldn't play this one" is as useless to somebody who is
   * signed out as the `NotSupportedError` it replaced. A line that could not be
   * produced belongs in the same line for the same reason: the recording IS the
   * episode and it plays, so this states what is not in it rather than raising
   * an alarm about it.
   */
  const meta = joinEpisodeMeta([
    `Episode ${episode.episodeNumber}`,
    formatEpisodeDate(episode.createdAt),
    problem === null
      ? formatEpisodeDuration(episode.durationMs)
      : EPISODE_AUDIO_PROBLEM_LABEL[problem],
    episode.creditsCharged ? `${episode.creditsCharged} credits` : '',
    missingLinesLabel,
  ]);

  /** What the episode is about: its recap once written, its topic until then. */
  const summary = episode.recap?.trim() || episode.topic;

  const progress = Math.max(2, Math.min(100, episode.progress));

  /**
   * The right edge is where the play control lives on Syra, so it is where
   * an episode's readiness is legible: the control itself when there is
   * something to hear, the work still happening when there is not.
   */
  const readiness = isPlayable ? (
    <Button
      tone="neutral"
      appearance="outline"
      size="md"
      icon={isPlaying ? RiPauseFill : RiPlayFill}
      loading={state === 'loading'}
      disabled={state === 'loading'}
      onPress={toggle}
      accessibilityRole="button"
      accessibilityLabel={isPlaying ? `Pause ${name}` : `Play ${name}`}
    />
  ) : isGenerating ? (
    <Loading variant="spinner" size="sm" />
  ) : episode.status === 'failed' ? (
    <RiErrorWarningLine width={18} height={18} fill={colors.error} />
  ) : null;

  return (
    <Item
      role="listitem"
      trailing={
        // Stacking only: the delete and readiness controls side by side.
        <View className="flex-row items-center gap-1">
          {/*
            The qualifier is load-bearing, not padding, and it had to change
            when the action did. This used to say "from Alia" because the
            recording survived on Syra; it now deletes there first and here
            second, so a label that still said "from Alia" would UNDERSTATE
            what a screen reader announces before someone presses it.
            "everywhere" is the whole promise.
          */}
          <Button
            tone="neutral"
            appearance="plain"
            size="sm"
            icon={RiDeleteBinLine}
            onPress={handleDelete}
            accessibilityRole="button"
            accessibilityLabel={`Delete ${name} everywhere`}
          />
          {readiness}
        </View>
      }
    >
      {/* Stacking only: the title block, with what the episode is about under it. */}
      <View className="min-w-0 flex-1 gap-1">
        <Text variant="headline-semibold" numberOfLines={2}>
          {name}
        </Text>
        <Text numberOfLines={1} className="text-xs text-muted-foreground">
          {meta}
        </Text>
        {summary ? (
          <Text numberOfLines={2} className="text-xs text-muted-foreground">
            {summary}
          </Text>
        ) : null}

        {isGenerating ? (
          <View className="gap-1 pt-1">
            <Meter
              value={progress}
              max={100}
              height={3}
              accessibilityLabel={`${name} progress`}
              valueText={`${progress}%`}
            />
            <View className="flex-row justify-between gap-2">
              <Text
                numberOfLines={1}
                className="text-[11px] leading-[15px] text-muted-foreground"
              >
                {live?.currentStep || STEP_LABEL[episode.status]}
              </Text>
              {live?.segmentIndex !== undefined && live.totalSegments !== undefined ? (
                <Text className="text-[11px] leading-[15px] text-muted-foreground">
                  Segment {live.segmentIndex}/{live.totalSegments}
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}

        {episode.status === 'failed' && episode.error ? (
          <Admonition type="error">{episode.error}</Admonition>
        ) : null}
      </View>
    </Item>
  );
}
