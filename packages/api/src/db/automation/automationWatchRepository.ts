/** Durable state of watch tasks between their cheap ticks (`lib/alia-watch.ts`). */

import { and, eq, sql } from 'drizzle-orm';
import type { ApiDatabase, Executor } from '../index';
import { automationDefinitions, automationWatchStates } from '../schema/agency';

export type AutomationWatchState = typeof automationWatchStates.$inferSelect;

export async function findAutomationWatchState(
  db: Executor,
  automationId: string,
): Promise<AutomationWatchState | null> {
  const [row] = await db
    .select()
    .from(automationWatchStates)
    .where(eq(automationWatchStates.automationId, automationId))
    .limit(1);
  return row ?? null;
}

/** A good tick: remember what was seen and end any failure streak. */
export async function recordAutomationWatchObservation(
  db: Executor,
  input: {
    automationId: string;
    hash: string;
    items: readonly string[];
    matched: boolean;
    changed: boolean;
    now: Date;
  },
): Promise<void> {
  const values = {
    lastHash: input.hash,
    lastItems: [...input.items],
    matched: input.matched,
    consecutiveFailures: 0,
    nextCheckAt: null,
    lastCheckedAt: input.now,
    pausedAt: null,
    ...(input.changed ? { lastChangedAt: input.now } : {}),
  };
  await db
    .insert(automationWatchStates)
    .values({ automationId: input.automationId, ...values })
    .onConflictDoUpdate({ target: automationWatchStates.automationId, set: values });
}

/** Backoff after `failures` consecutive failed ticks: min(60, 2^n) minutes. */
export function watchBackoffMs(failures: number): number {
  return Math.min(60, 2 ** Math.max(1, failures)) * 60_000;
}

/** A failed tick. Returns the length of the failure streak including this one. */
export async function recordAutomationWatchFailure(
  db: Executor,
  automationId: string,
  now: Date,
): Promise<number> {
  const [row] = await db
    .insert(automationWatchStates)
    .values({
      automationId,
      consecutiveFailures: 1,
      nextCheckAt: new Date(now.getTime() + watchBackoffMs(1)),
      lastCheckedAt: now,
    })
    .onConflictDoUpdate({
      target: automationWatchStates.automationId,
      set: {
        consecutiveFailures: sql`${automationWatchStates.consecutiveFailures} + 1`,
        lastCheckedAt: now,
      },
    })
    .returning({ failures: automationWatchStates.consecutiveFailures });
  const failures = row?.failures ?? 1;
  await db
    .update(automationWatchStates)
    .set({ nextCheckAt: new Date(now.getTime() + watchBackoffMs(failures)) })
    .where(eq(automationWatchStates.automationId, automationId));
  return failures;
}

/**
 * Pause a watch whose source keeps failing: disable the task and close the
 * streak. Conditional on the streak still being at least `threshold` long, so
 * exactly one caller pauses it — and that caller sends the one notification
 * the streak gets. A re-enabled task starts a new streak from zero.
 */
export async function pauseFailingAutomationWatch(
  db: ApiDatabase,
  automationId: string,
  threshold: number,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (transaction) => {
    const [paused] = await transaction
      .update(automationWatchStates)
      .set({ pausedAt: now, consecutiveFailures: 0, nextCheckAt: null })
      .where(
        and(
          eq(automationWatchStates.automationId, automationId),
          sql`${automationWatchStates.consecutiveFailures} >= ${threshold}`,
        ),
      )
      .returning({ automationId: automationWatchStates.automationId });
    if (!paused) return false;
    await transaction
      .update(automationDefinitions)
      .set({ enabled: false })
      .where(eq(automationDefinitions.id, automationId));
    return true;
  });
}
