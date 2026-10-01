/**
 * The computer host's process: config, store, the control API, the idle reaper.
 *
 * Runs as a container on the host instance (see oxy-infra
 * `terraform-uswest2/alia-computer-host.tf`), with the Docker socket mounted —
 * which is root on that machine, and is why nothing but the Alia API's role can
 * reach this API and why every container it creates runs under gVisor.
 */
import pino from 'pino';
import { WorkloadAuthority } from './attestation.js';
import { ComputerService } from './computer-service.js';
import { loadConfig } from './config.js';
import { runDocker } from './docker.js';
import { createApp } from './http.js';
import { MemoryStore, PostgresStore, type ComputerStore } from './store.js';

const REAP_INTERVAL_MS = 60_000;

const log = pino({ level: process.env.LOG_LEVEL || 'info', base: { service: 'alia-computer-host' } });

async function main() {
  const config = loadConfig();
  const store: ComputerStore = config.databaseUrl ? await PostgresStore.connect(config.databaseUrl) : new MemoryStore();
  if (!config.databaseUrl) log.warn('no DATABASE_URL: leases and receipts are in memory (local development only)');

  const service = new ComputerService({ store, docker: runDocker, config, log });
  const authority = new WorkloadAuthority({ allowedRoleArns: config.allowedRoleArns });
  let ready = false;
  const app = createApp({ service, authority, log, ready: () => ready });

  const server = app.listen(config.port, () => {
    ready = true;
    log.info({ port: config.port, runtime: config.runtime, maxRunning: config.maxRunning }, 'computer host listening');
  });

  let reaping = false;
  const reaper = setInterval(() => {
    if (reaping) return;
    reaping = true;
    service
      .reapIdle()
      .then((stopped) => {
        if (stopped > 0) log.info({ stopped }, 'idle computers stopped');
      })
      .catch((err: unknown) => log.error({ err: err instanceof Error ? err.message : 'unknown' }, 'idle sweep failed'))
      .finally(() => {
        reaping = false;
      });
  }, REAP_INTERVAL_MS);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    ready = false;
    clearInterval(reaper);
    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    clearTimeout(timeout);
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
}

main().catch((err: unknown) => {
  log.fatal({ err: err instanceof Error ? err.message : 'unknown' }, 'computer host failed to start');
  process.exit(1);
});
