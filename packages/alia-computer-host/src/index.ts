/**
 * The computer host's process: config, store, the control API, the idle reaper.
 *
 * Runs as a container on the host instance (see oxy-infra
 * `terraform-uswest2/alia-computer-host.tf`), with the Docker socket mounted —
 * which is root on that machine, and is why nothing but the Alia API's role can
 * reach this API and why every container it creates runs under gVisor.
 */
import { readFileSync } from 'node:fs';
import pino from 'pino';
import { WorkloadAuthority } from './attestation.js';
import { BrowserService } from './browser-service.js';
import { BrowserStack, upstreamResolvers } from './browser-stack.js';
import { ComputerService } from './computer-service.js';
import { loadConfig } from './config.js';
import { runDocker } from './docker.js';
import { createApp, createOpsApp } from './http.js';
import { MemoryStore, PostgresStore, type ComputerStore } from './store.js';

const REAP_INTERVAL_MS = 60_000;

const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'alia-computer-host' },
});

async function main() {
  const config = loadConfig();
  const store: ComputerStore = config.databaseUrl
    ? await PostgresStore.connect(config.databaseUrl)
    : new MemoryStore();
  if (!config.databaseUrl)
    log.warn('no DATABASE_URL: leases and receipts are in memory (local development only)');

  // The two services refer to each other: the browser holds computer slots
  // and its work keeps the host awake; a download lands in the computer.
  let browser: BrowserService | null = null;
  const service = new ComputerService({
    store,
    docker: runDocker,
    config,
    log,
    reservedSlots: async () => (browser ? browser.reservedSlots() : 0),
    extraActivity: async () => (browser ? browser.active() : false),
  });
  if (config.browser.enabled) {
    let dns: string[] = [];
    try {
      dns = upstreamResolvers(readFileSync('/etc/resolv.conf', 'utf8'));
    } catch {
      log.warn({}, 'no /etc/resolv.conf: the browser proxy will use its own resolver');
    }
    const stack = new BrowserStack({
      docker: runDocker,
      deploymentId: config.deploymentId,
      image: config.image,
      runtime: config.runtime,
      selfContainer: config.browser.selfContainer,
      dns,
      denyCidrs: config.browser.denyCidrs,
      maxContexts: config.browser.maxContexts,
      idleMs: config.browser.idleMs,
      log,
    });
    // A worker left by an earlier process holds a token this one never saw.
    await stack
      .reset()
      .catch((err: unknown) =>
        log.warn({ err: err instanceof Error ? err.message : 'unknown' }, 'browser reset failed'),
      );
    browser = new BrowserService({
      store,
      computers: service,
      stack,
      deploymentId: config.deploymentId,
      maxRunning: config.maxRunning,
      log,
    });
  }
  const authority = new WorkloadAuthority({ allowedRoleArns: config.allowedRoleArns });
  let ready = false;
  const app = createApp({ service, browser, authority, log, ready: () => ready });

  const server = app.listen(config.port, () => {
    ready = true;
    log.info(
      { port: config.port, runtime: config.runtime, maxRunning: config.maxRunning },
      'computer host listening',
    );
  });

  // Bound to every interface INSIDE the container; the systemd unit publishes
  // it on the instance's 127.0.0.1 only.
  const ops = createOpsApp({ service, idleStopMs: config.idleStopMs }).listen(config.opsPort);

  let reaping = false;
  const reaper = setInterval(() => {
    if (reaping) return;
    reaping = true;
    service
      .reapIdle()
      .then(async (stopped) => {
        if (stopped > 0) log.info({ stopped }, 'idle computers stopped');
        await browser?.reapIdle();
      })
      .catch((err: unknown) =>
        log.error({ err: err instanceof Error ? err.message : 'unknown' }, 'idle sweep failed'),
      )
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
    await new Promise<void>((resolve) => ops.close(() => resolve()));
    await store.close();
    clearTimeout(timeout);
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
}

main().catch((err: unknown) => {
  log.fatal(
    { err: err instanceof Error ? err.message : 'unknown' },
    'computer host failed to start',
  );
  process.exit(1);
});
