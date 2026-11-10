/**
 * Which weeks of an agent's activity the page draws, and what they add up to.
 *
 * Bloom's `ActivityHeatmap` never reads the clock: with no `endDate` its right edge is the latest
 * day that has data, and it draws `numDays` back from there at a fixed cell size. Left to itself on
 * a page that is only a few hundred pixels wide it drew a year's grid wider than its column and
 * the page scrolled it sideways from the OLDEST week, so the recent weeks, where an agent's
 * activity is, sat off-screen. The window is therefore the weeks that FIT the width, ending today.
 */

/** Bloom's defaults for a cell and the gap between cells, in px. */
export const CELL_SIZE = 12;
export const GAP = 3;
/** The most the page ever draws (a year), and the fewest worth drawing. */
export const MAX_WEEKS = 52;
export const MIN_WEEKS = 8;

/**
 * How many whole weeks of columns fit `width` px. A grid whose first week is partial takes one more
 * column than `weeks`, so one column is kept back.
 */
export function weeksThatFit(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return MIN_WEEKS;
  const columns = Math.floor((width + GAP) / (CELL_SIZE + GAP));
  return Math.min(MAX_WEEKS, Math.max(MIN_WEEKS, columns - 1));
}

const pad = (value: number) => String(value).padStart(2, '0');

/** `YYYY-MM-DD` of a date in the reader's own calendar: the "today" the grid ends on. */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The first of the `weeks * 7` days ending on `endDate` (both `YYYY-MM-DD`, read in UTC like Bloom). */
export function windowStart(endDate: string, weeks: number): string {
  const end = new Date(`${endDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - (weeks * 7 - 1));
  return end.toISOString().slice(0, 10);
}

/** What the days inside the window add up to, so the sentence above the grid says what the grid shows. */
export function interactionsIn(
  grid: readonly { date: string; count: number }[],
  endDate: string,
  weeks: number,
): number {
  const start = windowStart(endDate, weeks);
  return grid.reduce(
    (total, day) => (day.date >= start && day.date <= endDate ? total + day.count : total),
    0,
  );
}
