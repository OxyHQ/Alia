/**
 * How a show's episodes state a duration, a date and a count.
 *
 * These episodes are real podcasts on Syra, and Syra words all three a
 * particular way — `42 min`, `Yesterday`, `3 episodes`. An episode that reads
 * `1:05` in Alia and `1 min` on Syra is one recording described twice, so the
 * SHAPES here are Syra's (`packages/frontend/utils/podcastFormat.ts`,
 * `packages/studio/utils/format.ts`). The code is Alia's: a copied module drifts
 * from both products the first time either changes.
 *
 * Two deliberate differences from Syra's originals:
 *
 *  - Syra measures a duration in SECONDS (an RSS `<itunes:duration>`); Alia
 *    stores `durationMs`, which the pipeline measures off the assembled audio.
 *  - Syra reads an episode's `pubDate`; Alia has no publish date of its own, so
 *    the caller passes `createdAt` — when the episode was started, which is the
 *    same day it finishes for everything the pipeline produces.
 */

/** A day, in milliseconds. Relative dates are elapsed time, exactly as Syra's are. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `1 hr 23 min`, `42 min`, `45 sec` — and an EMPTY string when nothing measured
 * it, so a caller joining metadata with a separator drops the part rather than
 * printing a placeholder next to real facts.
 */
export function formatEpisodeDuration(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined) return '';
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '';

  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`;
  if (minutes > 0) return `${minutes} min`;
  return `${totalSeconds} sec`;
}

/**
 * `Today`, `Yesterday`, `3 days ago` — and an absolute date past a week.
 *
 * Elapsed days rather than calendar days, which is what Syra does: an episode
 * made 20 hours ago reads `Today` on both, and the two products never disagree
 * about the same recording.
 */
export function formatEpisodeDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '';

  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return '';

  const elapsedDays = Math.floor((Date.now() - parsed) / DAY_MS);
  if (elapsedDays <= 0) return 'Today';
  if (elapsedDays === 1) return 'Yesterday';
  if (elapsedDays < 7) return `${elapsedDays} days ago`;

  return new Date(parsed).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** `1 episode` / `4 episodes`, the way every Syra surface counts them. */
export function formatEpisodeCount(count: number): string {
  const safe = Math.max(0, Math.floor(count));
  return safe === 1 ? '1 episode' : `${safe} episodes`;
}

/**
 * The metadata line under an episode title: `Episode 3 · Today · 12 min`.
 *
 * Empty parts are dropped rather than rendered, so a separator never leads,
 * trails or doubles.
 */
export function joinEpisodeMeta(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' · ');
}
