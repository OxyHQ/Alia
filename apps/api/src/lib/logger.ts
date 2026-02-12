/**
 * Structured Logger for Alia API
 *
 * Uses pino for production-grade JSON logging with:
 * - Automatic pretty printing in development
 * - JSON output in production (for log aggregators)
 * - Sensitive data redaction (API keys, tokens)
 * - Subsystem child loggers
 *
 * Inspired by OpenClaw's logging patterns, adapted for server-side production use.
 */

import pino from 'pino';

// Patterns to redact from log output
const REDACT_PATHS = [
  'apiKey',
  'token',
  'authorization',
  'password',
  'secret',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
];

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Root logger instance.
 * - Development: pretty-printed with colors
 * - Production: JSON (fast, machine-parseable)
 */
const rootLogger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }
    : {
        // Production: raw JSON to stdout for log aggregators
        formatters: {
          level(label: string) {
            return { level: label };
          },
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }),
});

/**
 * Create a child logger with a subsystem label.
 *
 * Usage:
 *   const log = createLogger('auth');
 *   log.info({ userId }, 'User authenticated');
 *   log.error({ err }, 'Auth failed');
 */
export function createLogger(subsystem: string) {
  return rootLogger.child({ subsystem });
}

/**
 * Sanitize a string by removing potential API keys and tokens.
 * Use as a safety net before logging user-facing messages.
 */
export function sanitizeForLog(value: string): string {
  // Redact common API key patterns
  return value
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-[REDACTED]')
    .replace(/alia_sk_[a-zA-Z0-9_-]+/g, 'alia_sk_[REDACTED]')
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/key-[a-zA-Z0-9]{20,}/g, 'key-[REDACTED]');
}

// Pre-built loggers for common subsystems
export const log = {
  auth: createLogger('auth'),
  providers: createLogger('providers'),
  chat: createLogger('chat'),
  credits: createLogger('credits'),
  rateLimit: createLogger('rate-limit'),
  health: createLogger('health'),
  fallback: createLogger('fallback'),
  keys: createLogger('keys'),
  general: rootLogger,
};

export default rootLogger;
