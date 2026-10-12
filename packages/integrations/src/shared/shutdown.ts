import type { Logger } from './logger';

export interface ShutdownStep {
  name: string;
  run: () => Promise<void> | void;
}

/**
 * Run every shutdown step in order, each isolated from the others, and return
 * the names of the ones that failed.
 *
 * One `try` around the whole sequence meant the first step to throw skipped
 * every step after it: a Telegram bot that never started threw from `stop()`
 * and the Discord client and the Postgres pool were never closed.
 */
export async function runShutdownSteps(steps: ShutdownStep[], logger: Logger): Promise<string[]> {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
      logger.info(`${step.name} shut down`);
    } catch (err) {
      failed.push(step.name);
      logger.error(`Error shutting down ${step.name}:`, err);
    }
  }
  return failed;
}
