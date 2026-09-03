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
import { redactSecrets } from './agent/secret-scanner.js';

/**
 * The second chokepoint for credential material, and the only one that can see
 * an error this codebase did not build.
 *
 * Hosted inference now reaches Oxy through the published SDK, but arbitrary
 * errors can still carry bodies, URLs, headers or nested data. The live chat
 * path logs those errors as `{ err }`, and pino's default serializer copies
 * enumerable error properties. Scrubbing the serialized value is therefore a
 * necessary last boundary even though Alia no longer reads provider responses
 * or holds provider credentials itself.
 *
 * `redact.paths` below cannot do this job: pino paths are literal property
 * paths, so they would have to name `providerMessage`, `responseBody` and every
 * future sibling, and the one field that always carries the body — `message` —
 * cannot be blanked without destroying the log's only diagnostic content. This
 * scrubs VALUES instead: what a credential looks like, wherever it sits.
 */

/**
 * How deep into an error's own properties the scrub descends.
 *
 * The bound is what makes a CYCLIC structure terminate — an error whose `data`
 * points back at itself is legal and would otherwise recurse forever inside a
 * log call. A string is scrubbed at every depth; what the bound gives up is a
 * string inside an object nested deeper than this, which is passed through by
 * reference. Eight is well past the deepest real shape (`data.error.message`,
 * three) and short of a stack.
 */
const MAX_SCRUB_DEPTH = 8;

function scrubDeep(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactSecrets(value).redacted;
  if (value === null || typeof value !== 'object' || depth >= MAX_SCRUB_DEPTH) return value;
  if (Array.isArray(value)) return value.map((entry) => scrubDeep(entry, depth + 1));

  // A copy, never a mutation: `data` and `responseHeaders` on a serialized
  // error are references to the LIVE error object, and scrubbing in place would
  // edit application state from inside a logger.
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = scrubDeep(entry, depth + 1);
  return copy;
}

/**
 * Runs on the object pino's standard error serializer produces — a throwaway,
 * so its own string fields are safe to overwrite. `message` and `stack` already
 * carry every cause's message and stack concatenated, which is why scrubbing
 * them covers a wrapped error too.
 */
function scrubSerializedError(serialized: Record<string, unknown>): Record<string, unknown> {
  // The declared shape is a promise the caller does not keep: pino's standard
  // serializer returns its input untouched when that input is not error-like,
  // so `log.x.error({ err: 'a string' })` arrives here as a string. Assigning
  // to an index of one throws under ESM strict mode, which would turn a log
  // call into a crash.
  if (typeof serialized !== 'object' || serialized === null) return serialized;

  for (const [key, value] of Object.entries(serialized)) {
    serialized[key] = typeof value === 'string' ? redactSecrets(value).redacted : scrubDeep(value, 1);
  }
  return serialized;
}

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
  serializers: {
    err: pino.stdSerializers.wrapErrorSerializer(scrubSerializedError),
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
  automations: createLogger('automations'),
  organization: createLogger('organization'),
  skills: createLogger('skills'),
  codea: createLogger('codea'),
  memory: createLogger('memory'),
  developer: createLogger('developer'),
  webhook: createLogger('webhook'),
  telegram: createLogger('telegram'),
  channels: createLogger('channels'),
  seed: createLogger('seed'),
  tools: createLogger('tools'),
  v1: createLogger('v1'),
  models: createLogger('models'),
  canvas: createLogger('canvas'),
  agents: createLogger('agents'),
  triggers: createLogger('triggers'),
  /** One record per turn: the Alia and Kaana ids for it. Nothing else. */
  correlation: createLogger('correlation'),
  general: rootLogger,
};

export default rootLogger;
