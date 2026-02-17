import { docker, removePortExposure } from './docker.js';
import { log } from '../index.js';

const CLEANUP_INTERVAL_MS = 60_000; // Check every minute

export function startCleanupLoop(): void {
  setInterval(cleanupIdleContainers, CLEANUP_INTERVAL_MS);
  log.info('Container cleanup loop started (interval: %ds)', CLEANUP_INTERVAL_MS / 1000);
}

async function cleanupIdleContainers(): Promise<void> {
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: ['alia.managed=true'] },
    });

    const now = Date.now();

    for (const containerInfo of containers) {
      if (containerInfo.State !== 'running') continue;

      const labels = containerInfo.Labels || {};
      const timeoutMinutes = parseInt(labels['alia.timeout'] || '30', 10);
      const lastActivity = labels['alia.lastActivity']
        ? new Date(labels['alia.lastActivity']).getTime()
        : containerInfo.Created * 1000;

      const idleMs = now - lastActivity;
      const timeoutMs = timeoutMinutes * 60 * 1000;

      if (idleMs > timeoutMs) {
        const containerId = containerInfo.Id.slice(0, 12);
        const name = containerInfo.Names[0]?.replace(/^\//, '') || containerId;
        log.info(
          'Destroying idle container %s (idle: %dm, timeout: %dm)',
          name,
          Math.floor(idleMs / 60000),
          timeoutMinutes,
        );

        try {
          const container = docker.getContainer(containerInfo.Id);
          await removePortExposure(containerId);
          await container.stop({ t: 5 }).catch(() => {});
          await container.remove({ force: true });
        } catch (err) {
          log.warn({ err, containerId }, 'Failed to cleanup idle container');
        }
      }
    }
  } catch (err) {
    log.warn({ err }, 'Cleanup loop error');
  }
}
