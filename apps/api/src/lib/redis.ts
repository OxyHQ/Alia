/**
 * Shared Redis client singleton.
 * Used by rate limiting, Socket.IO adapter, and task queue.
 * Requires REDIS_URL env var. Returns null if not configured.
 */

import Redis from 'ioredis';
import { log } from './logger.js';

let client: Redis | null = null;
let subClient: Redis | null = null;

function parseRedisUrl(): { host: string; port: number; password?: string; username?: string; tls?: object } | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
      username: parsed.username || undefined,
      tls: parsed.protocol === 'rediss:' ? {} : undefined,
    };
  } catch {
    log.general.warn('REDIS_URL is set but could not be parsed');
    return null;
  }
}

/**
 * Get the shared Redis client (singleton). Returns null if REDIS_URL not set.
 */
export function getRedisClient(): Redis | null {
  if (client) return client;

  const config = parseRedisUrl();
  if (!config) return null;

  client = new Redis({
    ...config,
    maxRetriesPerRequest: 3,
    connectTimeout: 3000,
    commandTimeout: 2000,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });

  client.on('error', (err) => {
    log.general.error({ err }, 'Redis client error');
  });

  client.on('connect', () => {
    log.general.info('Redis connected');
  });

  return client;
}

/**
 * Get a dedicated subscriber client for Socket.IO adapter.
 * Socket.IO needs a separate connection in subscriber mode.
 */
export function getRedisSubClient(): Redis | null {
  if (subClient) return subClient;

  const config = parseRedisUrl();
  if (!config) return null;

  subClient = new Redis({
    ...config,
    maxRetriesPerRequest: 3,
    connectTimeout: 3000,
    commandTimeout: 2000,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });

  subClient.on('error', (err) => {
    log.general.error({ err }, 'Redis subscriber client error');
  });

  return subClient;
}

/**
 * Get BullMQ-compatible connection config (not an ioredis instance).
 * BullMQ requires maxRetriesPerRequest: null.
 */
export function getRedisConnection(): (ReturnType<typeof parseRedisUrl> & { maxRetriesPerRequest: null }) | null {
  const config = parseRedisUrl();
  if (!config) return null;
  return { ...config, maxRetriesPerRequest: null };
}

/**
 * Race a promise against a timeout. Used by rate limiters to fail-open
 * if Redis is slow. Exported so callers don't duplicate this helper.
 */
export const REDIS_TIMEOUT_MS = 1_000;

export function withRedisTimeout<T>(promise: Promise<T>, ms = REDIS_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Redis timeout')), ms),
    ),
  ]);
}

/**
 * Close all Redis connections. Call during graceful shutdown.
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
  if (subClient) {
    await subClient.quit();
    subClient = null;
  }
}
