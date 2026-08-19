/**
 * Provider credentials and their rotation state, on Postgres.
 *
 * ## The Mongoose METHODS, classified — and THREE OF FIVE WERE DEAD
 *
 * `provider-key.ts` carried five instance methods and two statics. Mongoose
 * methods have no Postgres counterpart, so each had to be decided rather than
 * translated — and the first thing that decides it is whether anything called
 * it. A repository-wide search for each name found:
 *
 *  - `validateKey`, `updateUsage`, `isAvailable` — **NO CALLERS ANYWHERE**.
 *    They are not re-expressed here, because re-expressing dead code carries it
 *    forward as though it were a requirement. `validateKey` compared a sha256
 *    digest and nothing ever asked it to; `updateUsage` was superseded by
 *    `key-manager`'s own `findByIdAndUpdate`; `isAvailable` restated the
 *    `is_archived = false AND is_active = true` predicate the selection query
 *    already carries.
 *  - `recordFailure`, `recordSuccess` — read-modify-write over counters, each
 *    `this.x += 1` followed by `save()`, called from `key-manager.ts`. They
 *    become single atomic statements, so two requests failing one key at once no
 *    longer lose an increment — which is what decides archival.
 *  - `hashKey` / `getKeyPrefix` (statics) — pure functions of a string that
 *    never needed a document. They are {@link hashProviderKey} and
 *    {@link providerKeyPrefix}, and every writer goes through them so the digest
 *    cannot drift between the create path and the rotate path.
 *
 * The column stays a keyed DIGEST rather than ciphertext, because it is what the
 * unique index and the duplicate check MATCH on: a randomized-IV scheme would
 * make that equality never match, and the symptom would be a silent duplicate
 * rather than an error.
 *
 * ## Priority is CLAMPED, and that is a behaviour change
 *
 * `recordFailure` set `current_priority = maxPriority + 1` to move a key to the
 * back of its queue. Mongo had no constraint, so the value grew without bound —
 * every failure across the pool ratchets it up by one. The Postgres column
 * carries `between 1 and 1000`, so the unbounded version would eventually make
 * the write FAIL, and `recordKeyFailure` swallows its errors: failures would
 * silently stop being recorded, and archival with them.
 *
 * So the increment is clamped to the ceiling. At the ceiling several failing
 * keys share a priority and their relative order stops being meaningful — which
 * is a better failure than a counter that stops counting, and it takes roughly a
 * thousand pool-wide failures to reach.
 */

import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import crypto from 'crypto';
import type { Executor } from '../index';
import { redactSecrets } from '../../lib/agent/secret-scanner';
import {
  auditedFields,
  recordConfigChange,
  type ConfigAuditActor,
} from '../../lib/security/config-audit.js';
import { providerKeys } from '../schema/providers';

/** The CHECK's ceiling on `current_priority`. Named so the clamp cannot drift. */
const MAX_CURRENT_PRIORITY = 1000;

/**
 * A row actually holds a credential: not null AND not blank.
 *
 * Both halves matter, and the second is the one SQL will not give you for free.
 * `getBestKeyForModel` refuses a valueless key with `if (!key.key)`, which is a
 * JavaScript falsy test and therefore rejects `''` exactly as it rejects `null`.
 * A bare `is not null` does not, so a row whose secret was blanked to an empty
 * string rather than nulled reads as credentialed to anything using it — while
 * routing skips the key. Written once and shared by both readers so the two
 * cannot drift apart; a `where` and a projection are different enough contexts
 * that they would.
 */
const hasKeyValue = sql<boolean>`(${providerKeys.key} is not null and ${providerKeys.key} <> '')`;

/** sha256 of a credential — the value the unique index is built on. */
export function hashProviderKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** The first few characters, for display. The one identifier safe to log. */
export function providerKeyPrefix(key: string): string {
  return key.substring(0, Math.min(8, key.length)) + '...';
}

export type ProviderKeyRow = typeof providerKeys.$inferSelect;

/**
 * A provider key WITHOUT its secret material.
 *
 * A different type rather than a filtered object: every admin route serves this
 * shape, and making it an `Omit` means reaching for `key` or `keyHash` on a
 * response body fails `tsc` rather than leaking on a code path nobody reread.
 * The source achieved the same with `.select('-keyHash -key')`, which is a
 * runtime string and silently does nothing if misspelled.
 */
export type SafeProviderKey = Omit<ProviderKeyRow, 'key' | 'keyHash'>;

/** Every column except the two secrets. */
const safeColumns = {
  id: providerKeys.id,
  name: providerKeys.name,
  provider: providerKeys.provider,
  environment: providerKeys.environment,
  keyPrefix: providerKeys.keyPrefix,
  rateLimitRps: providerKeys.rateLimitRps,
  rateLimitRpm: providerKeys.rateLimitRpm,
  rateLimitRph: providerKeys.rateLimitRph,
  rateLimitRpd: providerKeys.rateLimitRpd,
  rateLimitTps: providerKeys.rateLimitTps,
  rateLimitTpm: providerKeys.rateLimitTpm,
  rateLimitTph: providerKeys.rateLimitTph,
  rateLimitTpd: providerKeys.rateLimitTpd,
  isActive: providerKeys.isActive,
  isPaid: providerKeys.isPaid,
  tier: providerKeys.tier,
  currentPriority: providerKeys.currentPriority,
  originalPriority: providerKeys.originalPriority,
  creditLimitUsd: providerKeys.creditLimitUsd,
  spentUsd: providerKeys.spentUsd,
  lastUsedAt: providerKeys.lastUsedAt,
  lastSuccessAt: providerKeys.lastSuccessAt,
  totalRequests: providerKeys.totalRequests,
  totalTokens: providerKeys.totalTokens,
  successCount: providerKeys.successCount,
  consecutiveFailures: providerKeys.consecutiveFailures,
  totalFailures: providerKeys.totalFailures,
  lastFailureAt: providerKeys.lastFailureAt,
  lastFailureReason: providerKeys.lastFailureReason,
  cooldownUntil: providerKeys.cooldownUntil,
  rateLimitResetMs: providerKeys.rateLimitResetMs,
  maxTotalFailures: providerKeys.maxTotalFailures,
  isArchived: providerKeys.isArchived,
  archivedAt: providerKeys.archivedAt,
  archivedReason: providerKeys.archivedReason,
  rotatedAt: providerKeys.rotatedAt,
  expiresAt: providerKeys.expiresAt,
  rotationSchedule: providerKeys.rotationSchedule,
  ownerId: providerKeys.ownerId,
  organizationId: providerKeys.organizationId,
  createdAt: providerKeys.createdAt,
  updatedAt: providerKeys.updatedAt,
} as const;

// ============== SELECTION ==============

/**
 * The keys eligible to serve a provider, free before paid, each group by
 * ascending priority.
 *
 * The ordering was done in JavaScript — two `filter`s, two `sort`s and a
 * concatenation. It is one `ORDER BY` here: `is_paid` sorts false before true in
 * Postgres, which is the same "free first" rule stated where the index is.
 */
export async function loadActiveProviderKeys(
  db: Executor,
  provider: string,
): Promise<ProviderKeyRow[]> {
  return db
    .select()
    .from(providerKeys)
    .where(
      and(
        eq(providerKeys.provider, provider),
        eq(providerKeys.isArchived, false),
        eq(providerKeys.isActive, true),
      ),
    )
    .orderBy(asc(providerKeys.isPaid), asc(providerKeys.currentPriority), asc(providerKeys.id));
}

/**
 * The NAMES of providers holding at least one credential that could serve a
 * request now. No row, no prefix and no digest leaves this function.
 *
 * ## The predicate is `getBestKeyForModel`'s DURABLE half, deliberately
 *
 * That loop skips a key for six reasons. Four of them are properties of the row
 * that only an operator changes — archived, deactivated, past `expires_at`, over
 * `credit_limit_usd` — and one is the row being valueless, which is the same
 * kind of fact. Those five are here, the last through {@link hasKeyValue}, which
 * carries the empty-string half a bare `is not null` would miss.
 *
 * The two that are NOT here are `cooldown_until` and the eight rate limits, and
 * leaving them out is the whole point rather than an omission. Both clear
 * themselves within seconds to minutes, so a health report that counted them
 * would flip a provider between usable and unusable as traffic arrived — a
 * report that changes with load measures the load, and downstream that is a
 * probe that flaps. What this answers is the durable question: could this
 * provider serve at all, or is there nothing installed to serve WITH.
 *
 * `null` means UNLIMITED for `credit_limit_usd` and NO EXPIRY for `expires_at`,
 * matching the selection loop. Getting either backwards empties the result for
 * almost every row in the table, because almost every row leaves both null.
 *
 * Not to be confused with {@link countUsableKeys} below, which shares the word
 * and answers a different question: how many rows are live across the whole
 * table, on the two flags alone. It would count an expired, valueless,
 * credit-exhausted key as usable, which is right for the number it feeds (a
 * reload response's `keyCount`) and wrong for this one.
 */
export async function providersWithUsableKeys(db: Executor, now: Date): Promise<string[]> {
  const rows = await db
    .selectDistinct({ provider: providerKeys.provider })
    .from(providerKeys)
    .where(
      and(
        eq(providerKeys.isActive, true),
        eq(providerKeys.isArchived, false),
        hasKeyValue,
        or(isNull(providerKeys.expiresAt), gt(providerKeys.expiresAt, now)),
        or(
          isNull(providerKeys.creditLimitUsd),
          lt(providerKeys.spentUsd, providerKeys.creditLimitUsd),
        ),
      ),
    );
  return rows.map((row) => row.provider);
}

export async function findProviderKeyById(
  db: Executor,
  id: string,
): Promise<ProviderKeyRow | null> {
  const [row] = await db.select().from(providerKeys).where(eq(providerKeys.id, id));
  return row ?? null;
}

/** The safe projection of one key, or null. */
export async function findSafeProviderKeyById(
  db: Executor,
  id: string,
): Promise<SafeProviderKey | null> {
  const [row] = await db.select(safeColumns).from(providerKeys).where(eq(providerKeys.id, id));
  return row ?? null;
}

/** Whether any key already holds this digest — the duplicate check. */
export async function providerKeyHashExists(db: Executor, keyHash: string): Promise<boolean> {
  const [row] = await db
    .select({ id: providerKeys.id })
    .from(providerKeys)
    .where(eq(providerKeys.keyHash, keyHash));
  return row !== undefined;
}

export interface ListProviderKeysFilter {
  readonly provider?: string;
  readonly environment?: string;
  readonly isActive?: boolean;
}

/**
 * The admin list.
 *
 * BEHAVIOUR CHANGE, flagged: the source sorted `{ provider: 1, priority: 1 }`
 * and there is no `priority` field on this model — it is `currentPriority`. So
 * the secondary ordering was never applied and keys came back in whatever order
 * within a provider, which is arbitrary rather than intentional. This sorts by
 * `current_priority`, the field the name was reaching for, with `id` as a
 * deterministic tie-break.
 */
export async function listSafeProviderKeys(
  db: Executor,
  filter: ListProviderKeysFilter,
): Promise<SafeProviderKey[]> {
  return db
    .select(safeColumns)
    .from(providerKeys)
    .where(
      and(
        filter.provider ? eq(providerKeys.provider, filter.provider) : undefined,
        filter.environment ? eq(providerKeys.environment, filter.environment) : undefined,
        filter.isActive !== undefined ? eq(providerKeys.isActive, filter.isActive) : undefined,
      ),
    )
    .orderBy(asc(providerKeys.provider), asc(providerKeys.currentPriority), asc(providerKeys.id));
}

/** Diagnostics needs to know whether a key HAS a stored value, never what it is. */
export interface ProviderKeyDiagnostic extends SafeProviderKey {
  readonly hasKeyValue: boolean;
  readonly keyLength: number;
}

export async function listProviderKeyDiagnostics(
  db: Executor,
): Promise<ProviderKeyDiagnostic[]> {
  return db
    .select({
      ...safeColumns,
      // Computed in SQL so the plaintext never crosses the wire into this
      // process, let alone into a response.
      hasKeyValue,
      keyLength: sql<number>`coalesce(length(${providerKeys.key}), 0)::int`,
    })
    .from(providerKeys)
    .where(eq(providerKeys.isArchived, false))
    .orderBy(asc(providerKeys.provider), asc(providerKeys.currentPriority), asc(providerKeys.id));
}

// ============== WRITES ==============

export interface NewProviderKey {
  readonly name: string;
  readonly provider: string;
  readonly keyHash: string;
  readonly keyPrefix: string;
  readonly key: string;
  readonly environment: string;
  readonly isPaid: boolean;
  readonly tier: string;
  readonly priority: number;
  readonly rateLimit: {
    rps?: number; rpm?: number; rph?: number; rpd?: number;
    tps?: number; tpm?: number; tph?: number; tpd?: number;
  };
  readonly creditLimitUsd: number | null;
  readonly rateLimitResetMs: number | null;
}

export async function createProviderKey(
  db: Executor,
  entry: NewProviderKey,
  actor: ConfigAuditActor,
): Promise<SafeProviderKey> {
  const [row] = await db
    .insert(providerKeys)
    .values({
      name: entry.name,
      provider: entry.provider,
      keyHash: entry.keyHash,
      keyPrefix: entry.keyPrefix,
      key: entry.key,
      environment: entry.environment,
      isPaid: entry.isPaid,
      tier: entry.tier,
      currentPriority: entry.priority,
      originalPriority: entry.priority,
      rateLimitRps: entry.rateLimit.rps ?? null,
      rateLimitRpm: entry.rateLimit.rpm ?? null,
      rateLimitRph: entry.rateLimit.rph ?? null,
      rateLimitRpd: entry.rateLimit.rpd ?? null,
      rateLimitTps: entry.rateLimit.tps ?? null,
      rateLimitTpm: entry.rateLimit.tpm ?? null,
      rateLimitTph: entry.rateLimit.tph ?? null,
      rateLimitTpd: entry.rateLimit.tpd ?? null,
      creditLimitUsd: entry.creditLimitUsd,
      rateLimitResetMs: entry.rateLimitResetMs,
      isActive: true,
    })
    .returning(safeColumns);
  // `safeColumns` already excludes `key` and `key_hash`, and `AUDITED_FIELDS`
  // excludes them again. Two independent reasons a credential cannot reach the
  // record, because one of them is a projection somebody could widen.
  recordConfigChange({
    resource: 'provider_key',
    action: 'create',
    target: row.id,
    actor,
    before: null,
    after: auditedFields('provider_key', row),
  });
  return row;
}

/** The fields an admin PATCH may set. Anything else is not updatable by design. */
export interface ProviderKeyUpdate {
  name?: string;
  isActive?: boolean;
  isPaid?: boolean;
  tier?: string;
  currentPriority?: number;
  originalPriority?: number;
  creditLimitUsd?: number | null;
  /** Reset by the operator after topping up a provider account. */
  spentUsd?: number;
  rateLimitResetMs?: number | null;
  rateLimitRps?: number | null;
  rateLimitRpm?: number | null;
  rateLimitRph?: number | null;
  rateLimitRpd?: number | null;
  rateLimitTps?: number | null;
  rateLimitTpm?: number | null;
  rateLimitTph?: number | null;
  rateLimitTpd?: number | null;
}

export async function updateProviderKey(
  db: Executor,
  id: string,
  updates: ProviderKeyUpdate,
  actor: ConfigAuditActor,
): Promise<SafeProviderKey | null> {
  const previous = await findSafeProviderKeyById(db, id);
  const [row] = await db
    .update(providerKeys)
    .set({ ...updates, updatedAt: sql`date_trunc('milliseconds', now())` })
    .where(eq(providerKeys.id, id))
    .returning(safeColumns);
  if (!row) return null;
  recordConfigChange({
    resource: 'provider_key',
    action: 'update',
    target: id,
    actor,
    before: auditedFields('provider_key', previous),
    after: auditedFields('provider_key', row),
  });
  return row;
}

export async function deleteProviderKey(
  db: Executor,
  id: string,
  actor: ConfigAuditActor,
): Promise<SafeProviderKey | null> {
  const [row] = await db.delete(providerKeys).where(eq(providerKeys.id, id)).returning(safeColumns);
  if (!row) return null;
  recordConfigChange({
    resource: 'provider_key',
    action: 'delete',
    target: id,
    actor,
    before: auditedFields('provider_key', row),
    after: null,
  });
  return row;
}

/** Replace the credential in place, recording when. */
export async function rotateProviderKey(
  db: Executor,
  id: string,
  newKey: string,
  now: Date,
  actor: ConfigAuditActor,
): Promise<SafeProviderKey | null> {
  const previous = await findSafeProviderKeyById(db, id);
  const [row] = await db
    .update(providerKeys)
    .set({
      keyHash: hashProviderKey(newKey),
      keyPrefix: providerKeyPrefix(newKey),
      key: newKey,
      rotatedAt: now,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(eq(providerKeys.id, id))
    .returning(safeColumns);
  if (!row) return null;
  // The `before`/`after` differ only in `keyPrefix`, which is exactly the point:
  // the prefix is what `docs/runbooks/credential-rotation.md` matches a rotated
  // row by, and the record is the evidence the rotation happened.
  recordConfigChange({
    resource: 'provider_key',
    action: 'rotate',
    target: id,
    actor,
    before: auditedFields('provider_key', previous),
    after: auditedFields('provider_key', row),
  });
  return row;
}

// ============== ROTATION STATE ==============

/**
 * Note a request served by this key.
 *
 * The Mongoose method read the document, added to three fields and saved. This
 * is the same arithmetic done by the server, so concurrent requests through one
 * key cannot lose a count.
 */
export async function recordKeyUsage(
  db: Executor,
  id: string,
  tokens: number,
  now: Date,
): Promise<void> {
  await db
    .update(providerKeys)
    .set({
      lastUsedAt: now,
      totalRequests: sql`${providerKeys.totalRequests} + 1`,
      totalTokens: sql`${providerKeys.totalTokens} + ${tokens}`,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(eq(providerKeys.id, id));
}

/** The highest priority currently held in a key's own group (free or paid). */
export async function maxPriorityInGroup(
  db: Executor,
  provider: string,
  isPaid: boolean,
): Promise<number | null> {
  const [row] = await db
    .select({ currentPriority: providerKeys.currentPriority })
    .from(providerKeys)
    .where(
      and(
        eq(providerKeys.provider, provider),
        eq(providerKeys.isPaid, isPaid),
        eq(providerKeys.isArchived, false),
      ),
    )
    .orderBy(desc(providerKeys.currentPriority))
    .limit(1);
  return row?.currentPriority ?? null;
}

export interface FailureOutcome {
  readonly consecutiveFailures: number;
  readonly totalFailures: number;
  readonly archived: boolean;
  readonly currentPriority: number;
}

/**
 * Record a failure, move the key to the back of its queue, and archive it if it
 * has now failed too many times — all in one statement.
 *
 * A rate limit is transient: the key works and the quota does not, so it moves
 * neither failure counter and can never archive a key on its own. That
 * conditionality is why the two increments are interpolated.
 *
 * The archival test uses the POST-increment total, matching the source, and is
 * evaluated by the server against the stored row rather than against a snapshot
 * JavaScript read a moment earlier.
 *
 * ## `reason` is scrubbed here, and that is the second scrub, not the first
 *
 * `reason` is built from an upstream provider's error body, and a provider's
 * 401 quotes the credential it rejected. `last_failure_reason` is inside
 * {@link safeColumns}, so anything stored travels with every "safe" read of the
 * row — a projection built to exclude `key` and `key_hash` cannot exclude a
 * column that legitimately holds free text.
 *
 * `internal/providers/lib/provider-error-body.ts` already redacts at the point
 * the body is read, which is the scrub that can match the exact credential.
 * This one is here because the column, not the caller, is what has to be true:
 * a future writer that does not go through the provider tree still cannot store
 * key material. Redaction runs BEFORE the truncation, so a credential cannot
 * survive by sitting across the 500-character cut.
 *
 * The classification is deliberately NOT prepended to the stored string.
 * `key-manager.ts` decides `isRateLimit` by matching `/rate.?limit|429|…/`
 * against this same text, so writing the word `rate_limit` into it would change
 * which failures count toward archival — a behaviour change wearing a security
 * fix's clothes.
 */
export async function recordKeyFailure(
  db: Executor,
  id: string,
  reason: string,
  maxPriority: number,
  now: Date,
  isRateLimit: boolean,
): Promise<FailureOutcome | null> {
  const nextTotalFailures = isRateLimit
    ? sql`${providerKeys.totalFailures}`
    : sql`(${providerKeys.totalFailures} + 1)`;
  // Clamped: the column's CHECK stops at 1000 and this write is inside a caller
  // that swallows errors, so an unbounded increment would silently stop
  // recording failures — and archival with them.
  const nextPriority = Math.min(maxPriority + 1, MAX_CURRENT_PRIORITY);
  const archives = sql`(${nextTotalFailures} >= ${providerKeys.maxTotalFailures})`;

  const [row] = await db
    .update(providerKeys)
    .set({
      consecutiveFailures: isRateLimit
        ? sql`${providerKeys.consecutiveFailures}`
        : sql`${providerKeys.consecutiveFailures} + 1`,
      totalFailures: nextTotalFailures,
      lastFailureAt: now,
      lastFailureReason: redactSecrets(reason).redacted.substring(0, 500),
      currentPriority: nextPriority,
      isArchived: sql`case when ${archives} then true else ${providerKeys.isArchived} end`,
      isActive: sql`case when ${archives} then false else ${providerKeys.isActive} end`,
      archivedAt: sql`case when ${archives} then ${now.toISOString()}::timestamptz else ${providerKeys.archivedAt} end`,
      archivedReason: sql`case when ${archives}
        then 'Archived after ' || ${nextTotalFailures} || ' total failures'
        else ${providerKeys.archivedReason} end`,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(eq(providerKeys.id, id))
    .returning({
      consecutiveFailures: providerKeys.consecutiveFailures,
      totalFailures: providerKeys.totalFailures,
      archived: providerKeys.isArchived,
      currentPriority: providerKeys.currentPriority,
    });
  return row ?? null;
}

/**
 * Record a success: clear the consecutive-failure run, restore the original
 * priority, and reactivate a key that was deactivated but not archived.
 *
 * The cooldown is cleared here too. The source did it as a SECOND `updateOne`
 * immediately after `recordSuccess()`, with a window in between where the key
 * looked healthy and was still in cooldown; one statement removes it.
 */
export async function recordKeySuccess(
  db: Executor,
  id: string,
  now: Date,
): Promise<ProviderKeyRow | null> {
  const [row] = await db
    .update(providerKeys)
    .set({
      consecutiveFailures: 0,
      successCount: sql`${providerKeys.successCount} + 1`,
      lastSuccessAt: now,
      currentPriority: sql`${providerKeys.originalPriority}`,
      cooldownUntil: null,
      // An ARCHIVED key stays inactive. Reactivating one would put a credential
      // retired for repeated failure straight back into the rotation.
      isActive: sql`case when ${providerKeys.isArchived} then ${providerKeys.isActive} else true end`,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(eq(providerKeys.id, id))
    .returning();
  return row ?? null;
}

export async function setKeyCooldown(
  db: Executor,
  id: string,
  cooldownUntil: Date,
): Promise<void> {
  await db
    .update(providerKeys)
    .set({ cooldownUntil, updatedAt: sql`date_trunc('milliseconds', now())` })
    .where(eq(providerKeys.id, id));
}

/** Add to a key's spend. Atomic, because two completions can land together. */
export async function recordKeySpend(db: Executor, id: string, costUsd: number): Promise<void> {
  await db
    .update(providerKeys)
    .set({
      spentUsd: sql`${providerKeys.spentUsd} + ${costUsd}`,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(eq(providerKeys.id, id));
}

/**
 * Mark a key as having spent its whole allowance.
 *
 * Guarded on the limit being SET: with a null limit there is no value to raise
 * the spend to, and the source's `if (key.creditLimitUSD != null)` said the
 * same. Expressed as a predicate so it is one statement rather than a read
 * followed by a write.
 */
export async function markKeyCreditExhausted(db: Executor, id: string): Promise<boolean> {
  const result = await db
    .update(providerKeys)
    .set({
      spentUsd: sql`${providerKeys.creditLimitUsd}`,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(and(eq(providerKeys.id, id), isNotNull(providerKeys.creditLimitUsd)));
  return result.count > 0;
}

/** Clear every cooldown and failure run. The operator's reload button. */
export async function resetAllKeyCooldowns(db: Executor, actor: ConfigAuditActor): Promise<number> {
  const result = await db
    .update(providerKeys)
    .set({
      cooldownUntil: null,
      consecutiveFailures: 0,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(
      or(isNotNull(providerKeys.cooldownUntil), sql`${providerKeys.consecutiveFailures} > 0`),
    );
  // Audited, unlike `setKeyCooldown` and `markKeyCreditExhausted` beside it: a
  // key cools DOWN because an upstream said no, and it is cleared because a
  // person decided to clear it. The first is a metric and the second is a
  // configuration change, and only the second is here.
  //
  // Row-level `before`/`after` are `null` because the statement is a bulk
  // update over an unknown set; the count IS the change, and inventing a
  // per-row diff would mean reading every affected row first for a record
  // nobody reads per-row.
  recordConfigChange({
    resource: 'provider_key',
    action: 'reset',
    target: `cooldowns:${String(result.count)}`,
    actor,
    before: null,
    after: null,
  });
  return result.count;
}

/** How many keys are live — the reload response's `keyCount`. */
export async function countUsableKeys(db: Executor): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(providerKeys)
    .where(and(eq(providerKeys.isArchived, false), eq(providerKeys.isActive, true)));
  return row.count;
}

export interface ProviderKeyStats {
  readonly total: number;
  readonly active: number;
  readonly rateLimited: number;
  readonly averageSuccessRate: number;
  readonly totalRequests: number;
  readonly totalFailures: number;
}

/**
 * Per-provider key statistics.
 *
 * BEHAVIOUR CHANGE, flagged: the source divided the summed success rate by
 * `keys.length` with no guard, so a provider with NO keys produced `NaN`, which
 * `JSON.stringify` renders as `null`. That is a bug rather than a decision, and
 * porting it faithfully is not an option; an empty set now reports 0.
 *
 * A key that has neither succeeded nor failed counts as a rate of 1, matching
 * the source's `total > 0 ? successCount / total : 1` — an unused key is not
 * evidence of unreliability.
 */
export async function providerKeyStats(
  db: Executor,
  provider: string,
): Promise<ProviderKeyStats> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${providerKeys.isActive})::int`,
      averageSuccessRate: sql<number>`coalesce(avg(
        case when (${providerKeys.successCount} + ${providerKeys.totalFailures}) > 0
          then ${providerKeys.successCount}::double precision
               / (${providerKeys.successCount} + ${providerKeys.totalFailures})
          else 1
        end
      ), 0)::double precision`,
      totalRequests: sql<number>`coalesce(sum(${providerKeys.totalRequests}), 0)::int`,
      totalFailures: sql<number>`coalesce(sum(${providerKeys.totalFailures}), 0)::int`,
    })
    .from(providerKeys)
    .where(and(eq(providerKeys.provider, provider), eq(providerKeys.isArchived, false)));

  return {
    total: row.total,
    active: row.active,
    // Carried verbatim from the source, which never computed it and said so.
    rateLimited: 0,
    averageSuccessRate: row.averageSuccessRate,
    totalRequests: row.totalRequests,
    totalFailures: row.totalFailures,
  };
}
