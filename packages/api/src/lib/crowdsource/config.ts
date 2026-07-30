/**
 * Everything this deployment knows about CrowdSource, read once.
 *
 * Alia has no central config module — env is read inline at each call site — so
 * this is deliberately the exception rather than a new convention: the enabled
 * flag, the credential and the webhook secret have to be validated TOGETHER, and
 * a check that only exists where a value happens to be read is a check that runs
 * after the damage.
 *
 * ## There is no `CROWDSOURCE_APP_ID`, and one must never be added
 *
 * `applicationId` is read off the service credential by the SDK, which exposes no
 * option, field or parameter through which one could be passed. A variable holding
 * it could only ever disagree with the credential — and a tenant id the caller can
 * choose is not isolation, it is an IDOR. The envelope's copy exists so a mismatch
 * can be DETECTED; the credential is its only source.
 */

import { log } from '../logger.js';

export type ModerationEnforcementMode = 'observe' | 'manual' | 'automatic';

const ENFORCEMENT_MODES: readonly ModerationEnforcementMode[] = [
  'observe',
  'manual',
  'automatic',
];

const DEFAULT_OUTBOX_BATCH_SIZE = 50;
const DEFAULT_OUTBOX_POLL_INTERVAL_MS = 5_000;
const MIN_OUTBOX_POLL_INTERVAL_MS = 1_000;
const MAX_OUTBOX_BATCH_SIZE = 500;

export interface CrowdSourceConfig {
  readonly enabled: boolean;
  /** `applicationId:credentialId:secret`, ONE opaque value. Never split here. */
  readonly serviceKey?: string;
  /** Optional; the SDK defaults to the one deployment. */
  readonly baseUrl?: string;
  readonly webhookSecret?: string;
  /** Both are accepted while a secret is being rotated (§10.8). */
  readonly webhookPreviousSecret?: string;
  readonly outboxBatchSize: number;
  readonly outboxPollIntervalMs: number;
  readonly enforcementMode: ModerationEnforcementMode;
}

function trimmed(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * The mode, defaulting to `observe`.
 *
 * An unrecognised value also becomes `observe`. A typo in an environment variable
 * must never be the reason content is removed automatically — failing towards the
 * mode that changes nothing is the only safe reading.
 */
function enforcementMode(value: string | undefined): ModerationEnforcementMode {
  const candidate = trimmed(value);
  if (candidate === undefined) return 'observe';
  const match = ENFORCEMENT_MODES.find((mode) => mode === candidate);
  if (match) return match;
  log.general.warn(
    { value: candidate },
    '[CrowdSource] unrecognised CROWDSOURCE_ENFORCEMENT_MODE, falling back to observe',
  );
  return 'observe';
}

/**
 * Enabled requires BOTH halves of the round trip.
 *
 * A deployment with a service key and no webhook secret sends reports that can
 * never come back: cases open, juries decide, and Alia never learns the outcome —
 * with nothing failing anywhere to say so. Refusing to consider that "enabled" is
 * the only place this can be caught, because every later stage sees only its own
 * half.
 */
function readConfig(): CrowdSourceConfig {
  const requested = trimmed(process.env.CROWDSOURCE_ENABLED) === 'true';
  const serviceKey = trimmed(process.env.CROWDSOURCE_SERVICE_KEY);
  const webhookSecret = trimmed(process.env.CROWDSOURCE_WEBHOOK_SECRET);
  const enabled = requested && serviceKey !== undefined && webhookSecret !== undefined;

  if (requested && !enabled) {
    log.general.error(
      {
        hasServiceKey: serviceKey !== undefined,
        hasWebhookSecret: webhookSecret !== undefined,
      },
      '[CrowdSource] CROWDSOURCE_ENABLED=true but the integration is half-configured; staying off',
    );
  }

  return {
    enabled,
    ...(serviceKey === undefined ? {} : { serviceKey }),
    ...(trimmed(process.env.CROWDSOURCE_BASE_URL) === undefined
      ? {}
      : { baseUrl: trimmed(process.env.CROWDSOURCE_BASE_URL) }),
    ...(webhookSecret === undefined ? {} : { webhookSecret }),
    ...(trimmed(process.env.CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS) === undefined
      ? {}
      : { webhookPreviousSecret: trimmed(process.env.CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS) }),
    outboxBatchSize: boundedInteger(
      process.env.CROWDSOURCE_OUTBOX_BATCH_SIZE,
      DEFAULT_OUTBOX_BATCH_SIZE,
      1,
      MAX_OUTBOX_BATCH_SIZE,
    ),
    outboxPollIntervalMs: boundedInteger(
      process.env.CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS,
      DEFAULT_OUTBOX_POLL_INTERVAL_MS,
      MIN_OUTBOX_POLL_INTERVAL_MS,
      Number.MAX_SAFE_INTEGER,
    ),
    enforcementMode: enforcementMode(process.env.CROWDSOURCE_ENFORCEMENT_MODE),
  };
}

let cached: CrowdSourceConfig | null = null;

/**
 * The configuration, read on first use.
 *
 * Lazy rather than module-level because `dotenv.config()` runs inside
 * `src/index.ts` AFTER the import graph is evaluated — a top-level read would
 * capture the environment as it was before the `.env` file was loaded and report
 * every deployment as unconfigured.
 */
export function crowdSourceConfig(): CrowdSourceConfig {
  cached ??= readConfig();
  return cached;
}

/** Test hook. Production reads the environment once and keeps it. */
export function resetCrowdSourceConfig(): void {
  cached = null;
}
