import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatEpisodeCount,
  formatEpisodeDate,
  formatEpisodeDuration,
  joinEpisodeMeta,
} from '../show-format';
import { translator } from '@/shared/testing/translate';

/** The shipped catalogs, so these read what a person reads. */
const t = translator('en');
const es = translator('es');

/** Fixed so `Today` / `Yesterday` are decidable rather than dependent on the run. */
const NOW = Date.parse('2026-08-24T12:00:00.000Z');

describe('formatEpisodeDuration', () => {
  it('speaks a podcast duration in minutes, not in clock digits', () => {
    // The bug this pins: Alia used to render `12:30`, which is how a track
    // length is written and not how any Syra surface states an episode.
    expect(formatEpisodeDuration(750_000, t)).toBe('12 min');
  });

  it('adds hours only once there are any', () => {
    expect(formatEpisodeDuration(3_600_000, t)).toBe('1 hr');
    expect(formatEpisodeDuration(4_980_000, t)).toBe('1 hr 23 min');
  });

  it('falls back to seconds under a minute', () => {
    expect(formatEpisodeDuration(45_000, t)).toBe('45 sec');
  });

  it('says nothing at all when nothing measured it', () => {
    // An empty string is what lets `joinEpisodeMeta` DROP the part. `--:--`
    // would sit in the line beside real facts and read as a measurement.
    expect(formatEpisodeDuration(null, t)).toBe('');
    expect(formatEpisodeDuration(undefined, t)).toBe('');
    expect(formatEpisodeDuration(0, t)).toBe('');
    expect(formatEpisodeDuration(Number.NaN, t)).toBe('');
  });
});

describe('formatEpisodeDate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads Today for anything inside the last day', () => {
    expect(formatEpisodeDate('2026-08-24T09:00:00.000Z', t)).toBe('Today');
    expect(formatEpisodeDate('2026-08-23T20:00:00.000Z', t)).toBe('Today');
  });

  it('reads Yesterday a day back and counts days up to a week', () => {
    expect(formatEpisodeDate('2026-08-23T09:00:00.000Z', t)).toBe('Yesterday');
    expect(formatEpisodeDate('2026-08-21T09:00:00.000Z', t)).toBe('3 days ago');
    expect(formatEpisodeDate('2026-08-23T09:00:00.000Z', es)).toBe('Ayer');
    expect(formatEpisodeDate('2026-08-21T09:00:00.000Z', es)).toBe('Hace 3 días');
  });

  it('switches to an absolute date past a week', () => {
    expect(formatEpisodeDate('2026-08-01T09:00:00.000Z', t)).toBe(
      new Date(Date.parse('2026-08-01T09:00:00.000Z')).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
    );
  });

  it('says nothing for an absent or unparseable date', () => {
    expect(formatEpisodeDate(null, t)).toBe('');
    expect(formatEpisodeDate(undefined, t)).toBe('');
    expect(formatEpisodeDate('not a date', t)).toBe('');
  });
});

describe('formatEpisodeCount', () => {
  it('agrees the noun with the number', () => {
    expect(formatEpisodeCount(1, t)).toBe('1 episode');
    expect(formatEpisodeCount(0, t)).toBe('0 episodes');
    expect(formatEpisodeCount(4, t)).toBe('4 episodes');
  });

  it('never reports a negative count', () => {
    // The list derives this from `nextEpisodeNumber - 1`, so an off-by-one
    // upstream must not surface as `-1 episodes`.
    expect(formatEpisodeCount(-1, t)).toBe('0 episodes');
  });

  it('says the same in Spanish', () => {
    expect(formatEpisodeCount(1, es)).toBe('1 episodio');
    expect(formatEpisodeCount(4, es)).toBe('4 episodios');
    expect(formatEpisodeDuration(4_980_000, es)).toBe('1 h 23 min');
  });
});

describe('joinEpisodeMeta', () => {
  it('joins the parts a Syra episode row states, in order', () => {
    expect(joinEpisodeMeta(['Episode 3', 'Today', '12 min'])).toBe('Episode 3 · Today · 12 min');
  });

  it('drops empty parts rather than doubling the separator', () => {
    expect(joinEpisodeMeta(['Episode 3', '', null, '12 min'])).toBe('Episode 3 · 12 min');
    expect(joinEpisodeMeta(['', undefined])).toBe('');
  });
});
