/**
 * Releasing the containers an agent session still holds.
 *
 * All that survives of `lib/agent/tools.ts`, which was 519 lines of
 * `buildAgentTools` — a prefixed twenty-tool set (`browser_*`, `shell_*`,
 * `file_*`, …) that the five-assembler collapse confirmed had NO caller at all.
 * The five action primitives in `agent/actions.ts` replaced it long before, and
 * the only thing anybody still imported from that file was this function.
 */

import { getDb } from '../../db/index.js';
import { markAllAgentSessionResourcesDestroyed } from '../../db/agents/agentSessionRepository.js';
import { markContainerDestroyed } from '../../db/agents/containerRepository.js';
import { getSandboxProvider, isSandboxAvailable } from '../sandbox/index.js';
import { log } from '../logger.js';

/**
 * Destroy all active containers for a session (cleanup on completion/failure).
 *
 * Takes a session id and an owner rather than a document. The old signature
 * needed a hydrated session purely to walk `session.resources`, which meant the
 * CALLER's copy of that array decided what got destroyed — and the runner's copy
 * was loaded before the run started, so a container a tool created mid-run was
 * not in it and survived. The claim now comes from the table.
 *
 * The rows are marked destroyed FIRST, in one statement, and the returned ids
 * are what the sandbox provider is then asked to destroy. That ordering is
 * deliberate: a crash between the two leaks a container, which its own idle
 * clock reaps, while the reverse leaves a destroyed container recorded as active
 * and blocking the session's `maxVMs` budget forever.
 */
export async function cleanupSessionResources(
  sessionId: string,
  oxyUserId: string,
): Promise<void> {
  if (!isSandboxAvailable()) return;

  const sandbox = getSandboxProvider();
  const claimed = await markAllAgentSessionResourcesDestroyed(getDb(), sessionId);
  for (const containerId of claimed) {
    try {
      await sandbox.destroy(containerId);
      await markContainerDestroyed(getDb(), containerId, oxyUserId);
      log.agents.info({ containerId }, 'Cleaned up agent container');
    } catch (err) {
      log.agents.warn({ err, containerId }, 'Failed to clean up container');
    }
  }
}
