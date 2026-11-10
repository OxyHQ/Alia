import { describe, expect, it } from 'vitest';
import {
  MAX_WEEKS,
  MIN_WEEKS,
  interactionsIn,
  localDay,
  weeksThatFit,
  windowStart,
} from '@/features/agents/model/activity-window';

describe('the weeks of activity a page draws', () => {
  it('fits the width it has, so the grid is never wider than its column', () => {
    // A column of 476px (one of two on a laptop): 31 columns of 12px + 3px gaps, one kept back.
    expect(weeksThatFit(476)).toBe(30);
    // The width a year needs: 53 columns (52 weeks and a partial first one).
    expect(weeksThatFit(53 * 15)).toBe(MAX_WEEKS);
    expect(weeksThatFit(5000)).toBe(MAX_WEEKS);
  });

  it('never draws fewer than a couple of months, and survives an unmeasured width', () => {
    expect(weeksThatFit(60)).toBe(MIN_WEEKS);
    expect(weeksThatFit(0)).toBe(MIN_WEEKS);
    expect(weeksThatFit(Number.NaN)).toBe(MIN_WEEKS);
  });

  it('ends on the reader’s today, written the way Bloom reads it', () => {
    expect(localDay(new Date(2026, 10, 9, 23, 30))).toBe('2026-11-09');
    expect(localDay(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('starts the window `weeks * 7` days back, today included', () => {
    expect(windowStart('2026-11-09', 1)).toBe('2026-11-03');
    expect(windowStart('2026-11-09', 52)).toBe('2025-11-11');
  });

  it('adds up only the days the grid shows', () => {
    const grid = [
      { date: '2026-11-09', count: 3 },
      { date: '2026-10-01', count: 2 },
      { date: '2025-01-01', count: 7 },
      { date: '2026-11-10', count: 5 },
    ];
    expect(interactionsIn(grid, '2026-11-09', 30)).toBe(5);
    expect(interactionsIn(grid, '2026-11-09', 1)).toBe(3);
    expect(interactionsIn([], '2026-11-09', 30)).toBe(0);
  });
});
