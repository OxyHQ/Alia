/**
 * The statistics the runtime baseline reports, and nothing more.
 *
 * A runtime number from one run is not a measurement, it is an anecdote: the
 * same boot on the same machine varies with what the OS scheduler, the GPU and
 * the other tabs were doing. So every figure here is a distribution — median,
 * the full range, and a robust spread — over a stated number of runs.
 *
 * The spread is reported two ways on purpose:
 *
 *   - **IQR** (p75 − p25) describes the middle half and ignores the one run
 *     that hit a garbage collection. It is what the noise threshold is built
 *     from.
 *   - **min…max** is the honest worst case and is always printed next to it,
 *     because a tight IQR with a 3× outlier is a fact a reader needs.
 *
 * The median rather than the mean throughout: one 900ms stall would drag a mean
 * of seven runs by 130ms and say nothing about a typical boot.
 */

/** @param {number[]} values */
export function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * @param {number[]} raw
 * @returns {{ n: number, median: number, min: number, max: number, p25: number,
 *            p75: number, iqr: number, spreadPct: number, values: number[] } | null}
 */
export function describe(raw) {
  const values = raw.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return null;
  const median = quantile(values, 0.5);
  const p25 = quantile(values, 0.25);
  const p75 = quantile(values, 0.75);
  return {
    n: values.length,
    median,
    min: Math.min(...values),
    max: Math.max(...values),
    p25,
    p75,
    iqr: p75 - p25,
    // The IQR as a share of the median: the number that decides whether a
    // later difference is a change or the machine breathing.
    spreadPct: median > 0 ? ((p75 - p25) / median) * 100 : 0,
    values: values.map((v) => Math.round(v * 100) / 100),
  };
}

/**
 * Least-squares slope of `values` against their index.
 *
 * This is the leak test's verdict: the per-cycle growth of a counter that
 * should be flat. A single first-to-last difference would be dominated by
 * whichever cycle happened to run a garbage collection; a slope over every
 * cycle is not.
 *
 * @param {number[]} values
 */
export function slopePerStep(values) {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, v) => sum + v, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    numerator += (i - meanX) * (values[i] - meanY);
    denominator += (i - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/** `1234.5678` → `1234.57`, for JSON that a human is going to read. */
export function round(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** @param {ReturnType<typeof describe>} stat */
export function formatStat(stat, unit = 'ms') {
  if (!stat) return 'n/a';
  return (
    `${round(stat.median, 1)}${unit}` +
    ` (n=${stat.n}, IQR ${round(stat.iqr, 1)}${unit} = ${round(stat.spreadPct, 1)}%,` +
    ` range ${round(stat.min, 1)}–${round(stat.max, 1)}${unit})`
  );
}

/** Left-aligned fixed-width table, so a run's output is readable in a terminal. */
export function table(rows) {
  if (rows.length === 0) return '';
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => String(row[column] ?? '').length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === 0
            ? String(cell ?? '').padEnd(widths[column])
            : String(cell ?? '').padStart(widths[column]),
        )
        .join('  '),
    )
    .join('\n');
}
