/**
 * The CALLER for `expiryTargets.ts`.
 *
 * A registry with no caller is the failure this whole mechanism exists to
 * prevent, one level up: it makes the omission visible in code review and does
 * nothing whatsoever to the rows. A sibling service shipped exactly that and
 * carried ghost rows in production for weeks. So the registry and its schedule
 * land together, in the same change, always.
 *
 * ## It logs on EVERY run
 *
 * Including — especially — the runs that delete nothing. "Swept nothing because
 * there was nothing to sweep" and "never ran at all" produce identical tables,
 * and the only thing that can tell them apart afterwards is a line in the log
 * saying the sweep happened. The per-table counts go in the same line, so a
 * table that stops being swept is visible as a table that stopped appearing.
 *
 * ## One task sweeps, not all of them
 *
 * This service runs several ECS tasks. `sweepAllExpiredRows` is idempotent and
 * `DELETE … WHERE ctid IN (…)` is safe to run concurrently, so N sweepers would
 * be correct — but they would also be N times the write load for no benefit, so
 * it runs under the existing leader election, beside the trigger engine.
 *
 * `truncated` means the batch ceiling was hit and rows remain; it is logged
 * rather than looped, because the next interval will pick them up and an
 * unbounded catch-up loop is how a backlog becomes an outage.
 */

import { sweepAllExpiredRows } from '@oxyhq/db/expiry';
import { log } from '../lib/logger.js';
import { tryGetDb } from './index';
import { EXPIRY_TARGETS } from './expiryTargets';

/** How often to sweep. Mongo's own TTL monitor ran every 60s; this is less urgent. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Run one sweep across every registered target.
 *
 * Exported so an operator can run it once, and so the test suite can drive it
 * without waiting on a timer. Never throws: a failed sweep is a maintenance
 * problem, not a reason to take down whatever called it.
 */
export async function runExpirySweep(): Promise<void> {
  const db = tryGetDb();
  if (!db) return;

  try {
    const results = await sweepAllExpiredRows(db, EXPIRY_TARGETS);
    const deleted = results.reduce((total, r) => total + r.deleted, 0);
    const truncated = results.filter((r) => r.truncated).map((r) => r.table);

    // Logged unconditionally — see the header. A zero here is information.
    log.general.info(
      {
        deleted,
        perTable: Object.fromEntries(results.map((r) => [r.table, r.deleted])),
        ...(truncated.length > 0 ? { truncated } : {}),
      },
      'Expiry sweep complete',
    );
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Expiry sweep failed');
  }
}

/**
 * Start the periodic sweep. Call from the leader-election `onElected` hook.
 *
 * `unref()` so the interval cannot hold the event loop open — the convention
 * every module-level timer in this codebase follows, and what stops a test run
 * hanging on a scheduler nobody stopped.
 */
export function startExpirySweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runExpirySweep();
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  // Not awaited: startup must not block on maintenance.
  void runExpirySweep();
}

export function stopExpirySweeper(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
