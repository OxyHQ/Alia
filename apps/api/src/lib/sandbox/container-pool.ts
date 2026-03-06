/**
 * Container Pool — Pre-warmed Container Management
 *
 * Maintains a pool of ready-to-use containers to eliminate cold start latency.
 * Instead of creating containers on-demand (2-5s), agents get a pre-warmed
 * container from the pool instantly.
 *
 * Features:
 *   - Pre-warmed pool: keeps N warm containers ready
 *   - Container reuse: recycles containers for short sessions
 *   - Health monitoring: periodic health checks, auto-cleanup of unhealthy containers
 *   - Auto-replenish: refills pool when containers are claimed
 */

import { getSandboxProvider, type SandboxInfo, type CreateSandboxOptions } from './index.js';
import { log } from '../logger.js';

export interface PoolConfig {
  /** Number of warm containers to maintain per image */
  poolSize: number;
  /** Default image to pre-warm */
  defaultImage: string;
  /** Health check interval in ms */
  healthCheckIntervalMs: number;
  /** Max idle time before recycling (ms) */
  maxIdleMs: number;
  /** Additional images to pre-warm (optional) */
  warmImages?: string[];
}

interface PooledContainer {
  info: SandboxInfo;
  image: string;
  createdAt: number;
  lastUsedAt: number;
  claimed: boolean;
}

const DEFAULT_CONFIG: PoolConfig = {
  poolSize: 2,
  defaultImage: 'python:3.12',
  healthCheckIntervalMs: 60_000,
  maxIdleMs: 15 * 60_000, // 15 minutes
  warmImages: ['python:3.12', 'node:22'],
};

export class ContainerPool {
  private pool: PooledContainer[] = [];
  private config: PoolConfig;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private replenishing = false;

  constructor(config?: Partial<PoolConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the pool by pre-warming containers.
   * Call once at server startup.
   */
  async initialize(): Promise<void> {
    const sandbox = getSandboxProvider();
    if (!sandbox.isAvailable()) {
      log.agents.info('ContainerPool: sandbox not available, skipping initialization');
      return;
    }

    log.agents.info({ poolSize: this.config.poolSize, images: this.config.warmImages }, 'ContainerPool: initializing');

    // Pre-warm containers for each image
    const images = this.config.warmImages || [this.config.defaultImage];
    await Promise.allSettled(
      images.map(image => this.warmContainers(image, this.config.poolSize)),
    );

    // Start health monitoring
    this.healthCheckTimer = setInterval(() => this.healthCheck(), this.config.healthCheckIntervalMs);

    log.agents.info({ ready: this.pool.filter(c => !c.claimed).length }, 'ContainerPool: ready');
  }

  /**
   * Claim a container from the pool. Returns instantly if one is available,
   * otherwise falls back to creating a new one.
   */
  async claim(opts?: CreateSandboxOptions): Promise<SandboxInfo> {
    const image = opts?.image || this.config.defaultImage;
    const needsPersistent = !!opts?.persistent;

    // Try to find an unclaimed container with the right image.
    // Persistent sessions bypass warm containers because they are created with short TTL.
    const available = needsPersistent
      ? undefined
      : this.pool.find(c => !c.claimed && c.image === image);
    if (available) {
      available.claimed = true;
      available.lastUsedAt = Date.now();

      log.agents.info({ containerId: available.info.id, image }, 'ContainerPool: claimed from pool (instant)');

      // Replenish in background
      this.replenish(image).catch((err) => log.agents.warn({ err, image }, 'ContainerPool: background replenish failed'));

      return available.info;
    }

    // No pooled container available — create one directly
    log.agents.info({ image }, 'ContainerPool: no pooled container, creating new');
    const sandbox = getSandboxProvider();
    const info = await sandbox.createSandbox(opts || { image });

    // Track it as claimed
    this.pool.push({
      info,
      image,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      claimed: true,
    });

    return info;
  }

  /**
   * Release a container back to the pool for reuse, or destroy it.
   * Short-lived sessions release containers; long-lived ones destroy.
   */
  async release(sandboxId: string, destroy = false): Promise<void> {
    const idx = this.pool.findIndex(c => c.info.id === sandboxId);

    if (destroy || idx === -1) {
      // Destroy the container
      try {
        const sandbox = getSandboxProvider();
        await sandbox.destroy(sandboxId);
      } catch (err) {
        log.agents.warn({ err, sandboxId }, 'ContainerPool: failed to destroy');
      }
      if (idx >= 0) this.pool.splice(idx, 1);
      return;
    }

    // Reset and return to pool
    const pooled = this.pool[idx];
    try {
      const sandbox = getSandboxProvider();
      // Clean up workspace for reuse
      await sandbox.exec(sandboxId, 'rm -rf /workspace/* /workspace/.alia 2>/dev/null; true', 10);
      pooled.claimed = false;
      pooled.lastUsedAt = Date.now();
      log.agents.info({ sandboxId }, 'ContainerPool: released back to pool');
    } catch {
      // If cleanup fails, destroy it
      this.pool.splice(idx, 1);
      try {
        const sandbox = getSandboxProvider();
        await sandbox.destroy(sandboxId);
      } catch { /* ignore */ }
    }
  }

  /** Current pool statistics */
  stats(): { total: number; available: number; claimed: number } {
    return {
      total: this.pool.length,
      available: this.pool.filter(c => !c.claimed).length,
      claimed: this.pool.filter(c => c.claimed).length,
    };
  }

  /** Shutdown the pool and destroy all containers */
  async shutdown(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    const sandbox = getSandboxProvider();
    await Promise.allSettled(
      this.pool.map(c => sandbox.destroy(c.info.id).catch((err) => log.agents.warn({ err, sandboxId: c.info.id }, 'ContainerPool: destroy failed during shutdown'))),
    );
    this.pool = [];

    log.agents.info('ContainerPool: shut down');
  }

  // ── Internal ──

  private async warmContainers(image: string, count: number): Promise<void> {
    const sandbox = getSandboxProvider();

    const promises = Array.from({ length: count }, async () => {
      try {
        const info = await sandbox.createSandbox({
          image,
          labels: { 'alia.pool': 'warm' },
        });
        this.pool.push({
          info,
          image,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          claimed: false,
        });
      } catch (err) {
        log.agents.warn({ err, image }, 'ContainerPool: failed to warm container');
      }
    });

    await Promise.allSettled(promises);
  }

  private async replenish(image: string): Promise<void> {
    if (this.replenishing) return;
    this.replenishing = true;

    try {
      const available = this.pool.filter(c => !c.claimed && c.image === image).length;
      const needed = this.config.poolSize - available;
      if (needed > 0) {
        await this.warmContainers(image, needed);
      }
    } finally {
      this.replenishing = false;
    }
  }

  private async healthCheck(): Promise<void> {
    const sandbox = getSandboxProvider();
    const now = Date.now();

    for (let i = this.pool.length - 1; i >= 0; i--) {
      const c = this.pool[i];

      // Remove idle containers past max idle time
      if (!c.claimed && now - c.lastUsedAt > this.config.maxIdleMs) {
        log.agents.info({ sandboxId: c.info.id }, 'ContainerPool: evicting idle container');
        this.pool.splice(i, 1);
        sandbox.destroy(c.info.id).catch((err) => log.agents.warn({ err, sandboxId: c.info.id }, 'ContainerPool: destroy failed for idle container'));
        continue;
      }

      // Health check unclaimed containers
      if (!c.claimed) {
        try {
          const status = await sandbox.getStatus(c.info.id);
          if (!status.running) {
            log.agents.warn({ sandboxId: c.info.id }, 'ContainerPool: unhealthy container removed');
            this.pool.splice(i, 1);
            sandbox.destroy(c.info.id).catch((err) => log.agents.warn({ err, sandboxId: c.info.id }, 'ContainerPool: destroy failed for unhealthy container'));
          }
        } catch {
          this.pool.splice(i, 1);
          sandbox.destroy(c.info.id).catch((err) => log.agents.warn({ err, sandboxId: c.info.id }, 'ContainerPool: destroy failed during health check cleanup'));
        }
      }
    }

    // Replenish all warm images
    const images = this.config.warmImages || [this.config.defaultImage];
    for (const image of images) {
      await this.replenish(image);
    }
  }
}

/** Global container pool instance */
let globalPool: ContainerPool | null = null;

export function getContainerPool(config?: Partial<PoolConfig>): ContainerPool {
  if (!globalPool) {
    globalPool = new ContainerPool(config);
  }
  return globalPool;
}
