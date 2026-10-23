/**
 * Lightweight structured logger for @alia/integrations.
 *
 * Mirrors the `createLogger(subsystem)` convention from
 * packages/api/src/lib/logger.ts, without pulling pino into this service:
 * it only needs level-gated, subsystem-prefixed lines on stdout/stderr.
 * Routing every log line through here gives the package a single place to
 * control log level (and to add secret redaction later).
 *
 * This module is the sole logging sink for the package — `process.stdout` /
 * `process.stderr` are written directly so no `console.*` calls remain in
 * application code.
 */

import { format } from 'node:util';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveThreshold(): number {
  const configured = process.env.LOG_LEVEL;
  if (
    configured === 'debug' ||
    configured === 'info' ||
    configured === 'warn' ||
    configured === 'error'
  ) {
    return LEVEL_WEIGHT[configured];
  }
  return process.env.NODE_ENV === 'production' ? LEVEL_WEIGHT.info : LEVEL_WEIGHT.debug;
}

const threshold = resolveThreshold();

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const SECRET_KEY = /authorization|cookie|password|secret|token|api[-_]?key/i;
function safeLog(value: unknown, depth = 0): unknown {
  if (typeof value === 'string')
    return value
      .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]');
  if (!value || typeof value !== 'object') return value;
  if (depth >= 8) return '[TRUNCATED]';
  if (value instanceof Error)
    return {
      name: value.name,
      message: safeLog(value.message),
      ...Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          SECRET_KEY.test(key) ? '[REDACTED]' : safeLog(entry, depth + 1),
        ]),
      ),
    };
  if (Array.isArray(value)) return value.map((entry) => safeLog(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SECRET_KEY.test(key) ? '[REDACTED]' : safeLog(entry, depth + 1),
    ]),
  );
}

function emit(level: LogLevel, subsystem: string, message: string, args: unknown[]): void {
  if (LEVEL_WEIGHT[level] < threshold) return;
  const line = format(`[${subsystem}] ${safeLog(message)}`, ...args.map((arg) => safeLog(arg)));
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export function createLogger(subsystem: string): Logger {
  return {
    debug: (message, ...args) => emit('debug', subsystem, message, args),
    info: (message, ...args) => emit('info', subsystem, message, args),
    warn: (message, ...args) => emit('warn', subsystem, message, args),
    error: (message, ...args) => emit('error', subsystem, message, args),
  };
}
