/**
 * When the catalogue sync runs, and on which task.
 *
 * Separate from `sync.ts` so that the sync itself is a function anybody can
 * call — an operator script, a test, a future admin button — and the SCHEDULE is
 * one thing in one place.
 *
 * Leader-gated through the same lease mechanism the trigger engine uses: every
 * task competes, one wins, and only the winner syncs. Without that, six tasks
 * would each download the same repositories and write the same rows on top of
 * each other every day.
 *
 * The first run is delayed rather than immediate. A deploy rolls tasks one at a
 * time, and a sync starting inside the first seconds of a task's life competes
 * with request warm-up for the same process — for work whose result is a day
 * old by definition.
 */

import { startLeaderElection, type LeaderElectionHandle } from '../leader-election.js';
import { log } from '../logger.js';
import { syncSkillRegistry } from './sync.js';

const LEASE = 'skill-registry-sync';
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;

let election: LeaderElectionHandle | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let firstRun: ReturnType<typeof setTimeout> | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;

/** Never sooner than this after a rate limit, and never later than the next daily run would be. */
const MIN_RETRY_MS = 60 * 1000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;

async function runOnce(): Promise<void> {
  // Never throws into a timer: an unhandled rejection here would take the
  // process down for a catalogue that is merely stale.
  const report = await syncSkillRegistry().catch((err) => {
    log.general.error({ err }, 'Skill registry sync failed');
    return null;
  });
  // A rate limit says when to come back; waiting a whole day for a limit that
  // resets within the hour leaves the catalogue stale for no reason.
  if (retry) clearTimeout(retry);
  retry = null;
  if (report?.retryAt) {
    const wait = Math.min(
      Math.max(report.retryAt.getTime() - Date.now(), MIN_RETRY_MS),
      MAX_RETRY_MS,
    );
    retry = setTimeout(() => void runOnce(), wait);
  }
}

function clearTimers(): void {
  if (firstRun) clearTimeout(firstRun);
  if (timer) clearInterval(timer);
  if (retry) clearTimeout(retry);
  firstRun = null;
  timer = null;
  retry = null;
}

export function startSkillRegistrySync(): void {
  if (election) return;
  election = startLeaderElection(LEASE, {
    onElected: () => {
      log.general.info('Elected to sync the skill registry');
      firstRun = setTimeout(() => void runOnce(), FIRST_RUN_DELAY_MS);
      timer = setInterval(() => void runOnce(), INTERVAL_MS);
    },
    onDemoted: clearTimers,
  });
}

export async function stopSkillRegistrySync(): Promise<void> {
  clearTimers();
  await election?.stop();
  election = null;
}
