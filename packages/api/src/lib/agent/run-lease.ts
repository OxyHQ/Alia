/**
 * The run lease a worker holds on one agent session while it drives it:
 * renewed on an interval until stopped or lost. Claiming and releasing it are
 * `runAgentSession`'s (`runner.ts`).
 */
import { getDb } from '../../db/index.js';
import { renewAgentSessionRunLease } from '../../db/agents/agentSessionRepository.js';
import { log } from '../logger.js';

/** How often a worker renews its claim; well inside `RUNNER_LEASE_MS`. */
const RUNNER_LEASE_RENEW_MS = 20_000;

/** This worker's hold on one run, renewed until it is stopped or lost. */
export interface RunLease {
  readonly owner: string;
  /** Set when a renewal found the run no longer ours: stop driving it. */
  lost: boolean;
  stop(): void;
}

export function holdRunLease(sessionId: string, owner: string): RunLease {
  const lease: RunLease = {
    owner,
    lost: false,
    stop: () => clearInterval(timer),
  };
  const timer = setInterval(() => {
    renewAgentSessionRunLease(getDb(), sessionId, owner)
      .then((held) => {
        if (!held) {
          lease.lost = true;
          clearInterval(timer);
        }
      })
      // A failed renewal is not a lost lease: the next one may land, and the
      // lease outlives several missed renewals.
      .catch((err: unknown) =>
        log.agents.warn({ err, sessionId }, 'Could not renew the run lease'),
      );
  }, RUNNER_LEASE_RENEW_MS);
  timer.unref?.();
  return lease;
}
