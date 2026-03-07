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
    maxRetriesPerRequest: null, // Required for BullMQ compatibility
    lazyConnect: true,
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
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });

  subClient.on('error', (err) => {
    log.general.error({ err }, 'Redis subscriber client error');
  });

  return subClient;
}

/**
 * Get BullMQ-compatible connection config (not an ioredis instance).
 */
export function getRedisConnection(): ReturnType<typeof parseRedisUrl> {
  return parseRedisUrl();
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
