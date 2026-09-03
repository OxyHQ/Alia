/**
 * Alia's virtual models and the provider models that serve them, on Postgres.
 *
 * Two tables from one Mongoose model: `routing_profiles` and its `providerMappings`
 * sub-document array, which is a CHILD TABLE here. That was not an arbitrary
 * choice — each element carries a reference to `model_configs` and a per-element
 * `is_active`, so `jsonb` would hide a foreign key inside an opaque value and
 * leave "does this mapping point at a model that still exists" unanswerable.
 *
 * ## The wire shape keeps `providerMappings` nested
 *
 * The admin clients read `model.providerMappings[i].provider`, so every read
 * rejoins the child rows onto the parent and serves them under that name, with
 * `_id` alongside `id`. The table being normalised is an implementation detail
 * the API does not expose.
 *
 * ## Replacing the mappings is a REPLACE, not an append
 *
 * Mongo's `$set: { providerMappings }` overwrote the array wholesale, and the
 * unique index this schema adds — `(routing_profile_id, model_config_id)` — is
 * something a sub-document array could not express. So the only thing keeping
 * duplicates out was that whole-array `$set`. {@link replaceProviderMappings}
 * reproduces it inside a transaction: delete every mapping for the model, insert
 * the new set. An implementation that upserted instead would leave mappings the
 * caller had dropped, quietly routing to a provider the operator removed.
 */

import { and, asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { ApiDatabase, Executor } from '../index';
import { assertUnreservedModelIdentifier } from '../../lib/reserved-namespace.js';
import {
  auditedFields,
  recordConfigChange,
  type ConfigAuditActor,
} from '../../lib/security/config-audit.js';
import { routingProfileProviderMappings, routingProfiles, modelConfigs } from '../schema/providers';

export type RoutingProfileRow = typeof routingProfiles.$inferSelect;
export type ProviderMappingRow = typeof routingProfileProviderMappings.$inferSelect;

export interface ProviderMappingInput {
  modelConfigId: string;
  provider: string;
  modelId: string;
  priority: number;
  qualityScore: number;
  isActive?: boolean;
}

export interface AggregatedCapabilities {
  vision: boolean;
  audio: boolean;
  codeExecution: boolean;
  webSearch: boolean;
  thinking: boolean;
}

/** The nested JSON shape the admin clients consume. */
export interface RoutingProfileView {
  _id: string;
  id: string;
  routingProfileId: string;
  displayName: string;
  tier: string;
  description: string | null;
  features: string[];
  creditMultiplier: number;
  isFreeTier: boolean;
  aggregatedCapabilities: AggregatedCapabilities;
  providerMappings: ProviderMappingInput[];
  isActive: boolean;
  isDeprecated: boolean;
  isLegacy: boolean;
  deprecationDate: Date | null;
  replacementModelId: string | null;
  totalRequests: number;
  totalTokens: number;
  averageLatencyMs: number;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toView(row: RoutingProfileRow, mappings: ProviderMappingRow[]): RoutingProfileView {
  return {
    _id: row.id,
    id: row.id,
    routingProfileId: row.routingProfileId,
    displayName: row.displayName,
    tier: row.tier,
    description: row.description,
    features: row.features,
    creditMultiplier: row.creditMultiplier,
    isFreeTier: row.isFreeTier,
    aggregatedCapabilities: {
      vision: row.aggregatedCapabilitiesVision,
      audio: row.aggregatedCapabilitiesAudio,
      codeExecution: row.aggregatedCapabilitiesCodeExecution,
      webSearch: row.aggregatedCapabilitiesWebSearch,
      thinking: row.aggregatedCapabilitiesThinking,
    },
    providerMappings: mappings.map((m) => ({
      modelConfigId: m.modelConfigId,
      provider: m.provider,
      modelId: m.modelId,
      priority: m.priority,
      qualityScore: m.qualityScore,
      isActive: m.isActive,
    })),
    isActive: row.isActive,
    isDeprecated: row.isDeprecated,
    isLegacy: row.isLegacy,
    deprecationDate: row.deprecationDate,
    replacementModelId: row.replacementModelId,
    totalRequests: row.totalRequests,
    totalTokens: row.totalTokens,
    averageLatencyMs: row.averageLatencyMs,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Attach the mappings to a set of parent rows.
 *
 * ONE query for every parent rather than one per parent: the list endpoints
 * return the whole catalogue, and a per-row read there is the N+1 that turns a
 * fast page into a slow one as the catalogue grows.
 */
async function withMappings(db: Executor, rows: RoutingProfileRow[]): Promise<RoutingProfileView[]> {
  if (rows.length === 0) return [];
  const mappings = await db
    .select()
    .from(routingProfileProviderMappings)
    .where(inArray(routingProfileProviderMappings.routingProfileId, rows.map((r) => r.id)))
    .orderBy(asc(routingProfileProviderMappings.priority), asc(routingProfileProviderMappings.id));

  const byModel = new Map<string, ProviderMappingRow[]>();
  for (const m of mappings) {
    const list = byModel.get(m.routingProfileId);
    if (list) list.push(m);
    else byModel.set(m.routingProfileId, [m]);
  }
  return rows.map((row) => toView(row, byModel.get(row.id) ?? []));
}

export interface ListRoutingProfilesFilter {
  tier?: string;
  isActive?: boolean;
  isDeprecated?: boolean;
}

export async function listRoutingProfiles(
  db: Executor,
  filter: ListRoutingProfilesFilter = {},
): Promise<RoutingProfileView[]> {
  const rows = await db
    .select()
    .from(routingProfiles)
    .where(
      and(
        filter.tier ? eq(routingProfiles.tier, filter.tier) : undefined,
        filter.isActive !== undefined ? eq(routingProfiles.isActive, filter.isActive) : undefined,
        filter.isDeprecated !== undefined
          ? eq(routingProfiles.isDeprecated, filter.isDeprecated)
          : undefined,
      ),
    )
    .orderBy(asc(routingProfiles.tier), asc(routingProfiles.routingProfileId));
  return withMappings(db, rows);
}

export async function findRoutingProfile(
  db: Executor,
  routingProfileId: string,
): Promise<RoutingProfileView | null> {
  const [row] = await db.select().from(routingProfiles).where(eq(routingProfiles.routingProfileId, routingProfileId));
  if (!row) return null;
  const [view] = await withMappings(db, [row]);
  return view;
}

export interface RoutingProfileInput {
  routingProfileId?: string;
  displayName?: string;
  tier?: string;
  description?: string | null;
  features?: string[];
  creditMultiplier?: number;
  isFreeTier?: boolean;
  aggregatedCapabilities?: Partial<AggregatedCapabilities>;
  isActive?: boolean;
  isDeprecated?: boolean;
  isLegacy?: boolean;
  deprecationDate?: Date | null;
  replacementModelId?: string | null;
  notes?: string | null;
}

function toColumns(input: RoutingProfileInput): Partial<typeof routingProfiles.$inferInsert> {
  const out: Partial<typeof routingProfiles.$inferInsert> = {};
  const put = <K extends keyof typeof out>(key: K, value: (typeof out)[K] | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  put('routingProfileId', input.routingProfileId);
  put('displayName', input.displayName);
  put('tier', input.tier);
  put('description', input.description);
  put('features', input.features);
  put('creditMultiplier', input.creditMultiplier);
  put('isFreeTier', input.isFreeTier);
  put('aggregatedCapabilitiesVision', input.aggregatedCapabilities?.vision);
  put('aggregatedCapabilitiesAudio', input.aggregatedCapabilities?.audio);
  put('aggregatedCapabilitiesCodeExecution', input.aggregatedCapabilities?.codeExecution);
  put('aggregatedCapabilitiesWebSearch', input.aggregatedCapabilities?.webSearch);
  put('aggregatedCapabilitiesThinking', input.aggregatedCapabilities?.thinking);
  put('isActive', input.isActive);
  put('isDeprecated', input.isDeprecated);
  put('isLegacy', input.isLegacy);
  put('deprecationDate', input.deprecationDate);
  put('replacementModelId', input.replacementModelId);
  put('notes', input.notes);
  return out;
}

/**
 * Replace a model's provider mappings wholesale.
 *
 * In a transaction, because the delete and the insert are one fact: a failure
 * between them would leave the model with NO providers and nothing to say so.
 *
 * **Module-private since #139 ws15.** It mutates the routing table and its only
 * callers were the three writers below, which audit the whole change including
 * the mappings. Exported, it was a public routing mutation that emitted no
 * audit record and that the writer census in
 * `routes/__tests__/inference-boundary.test.ts` could not see, because that
 * census matches names beginning `create|update|delete|upsert|set|reset|mark`
 * and this one begins `replace`.
 */
async function replaceProviderMappings(
  tx: Executor,
  routingProfileId: string,
  mappings: ProviderMappingInput[],
): Promise<void> {
  await tx
    .delete(routingProfileProviderMappings)
    .where(eq(routingProfileProviderMappings.routingProfileId, routingProfileId));
  if (mappings.length === 0) return;
  await tx.insert(routingProfileProviderMappings).values(
    mappings.map((m) => ({
      routingProfileId,
      modelConfigId: m.modelConfigId,
      provider: m.provider,
      modelId: m.modelId,
      priority: m.priority,
      qualityScore: m.qualityScore,
      isActive: m.isActive ?? true,
    })),
  );
}

export async function createRoutingProfile(
  db: ApiDatabase,
  input: RoutingProfileInput,
  mappings: ProviderMappingInput[],
  actor: ConfigAuditActor,
): Promise<RoutingProfileView> {
  // ADR 0002: nothing may occupy the reserved `alia/*` publisher namespace.
  // Refused before the transaction opens, so a rejected registration costs no
  // round trip and cannot half-apply.
  if (input.routingProfileId !== undefined) assertUnreservedModelIdentifier(input.routingProfileId);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(routingProfiles)
      .values(toColumns(input) as typeof routingProfiles.$inferInsert)
      .returning();
    await replaceProviderMappings(tx, row.id, mappings);
    const [view] = await withMappings(tx, [row]);
    recordConfigChange({
      resource: 'routing_profile',
      action: 'create',
      target: view.routingProfileId,
      actor,
      before: null,
      after: auditedFields('routing_profile', view),
    });
    return view;
  });
}

/**
 * Update a model, and its mappings only when the caller supplied them.
 *
 * `undefined` mappings mean "leave them alone"; an EMPTY ARRAY means "this model
 * now has none". Collapsing the two would make a PATCH of the display name
 * silently unroute the model.
 *
 * No reserved-namespace check here, and that is a consequence of the code rather
 * than an omission: the SET clause drops `routingProfileId` below, so an identity
 * cannot move through an update and no new identifier can enter this way.
 */
export async function updateRoutingProfile(
  db: ApiDatabase,
  routingProfileId: string,
  input: RoutingProfileInput,
  actor: ConfigAuditActor,
  mappings?: ProviderMappingInput[],
): Promise<RoutingProfileView | null> {
  return db.transaction(async (tx) => {
    // Read BEFORE the write, inside the same transaction, so the record's
    // `before` is the state this statement replaced rather than whatever the row
    // held whenever a second query happened to run.
    const previous = await findRoutingProfile(tx, routingProfileId);
    const columns = toColumns(input);
    // The identity does not move through an update.
    delete columns.routingProfileId;

    const [row] = await tx
      .update(routingProfiles)
      .set({ ...columns, updatedAt: sql`date_trunc('milliseconds', now())` })
      .where(eq(routingProfiles.routingProfileId, routingProfileId))
      .returning();
    if (!row) return null;

    if (mappings !== undefined) {
      await replaceProviderMappings(tx, row.id, mappings);
    }
    const [view] = await withMappings(tx, [row]);
    recordConfigChange({
      resource: 'routing_profile',
      action: 'update',
      target: view.routingProfileId,
      actor,
      before: auditedFields('routing_profile', previous),
      after: auditedFields('routing_profile', view),
    });
    return view;
  });
}

/**
 * Delete a model. Its mappings go with it by `ON DELETE CASCADE`, so they are
 * read BEFORE the delete to serve the response the route already returns.
 */
export async function deleteRoutingProfile(
  db: ApiDatabase,
  routingProfileId: string,
  actor: ConfigAuditActor,
): Promise<RoutingProfileView | null> {
  return db.transaction(async (tx) => {
    const existing = await findRoutingProfile(tx, routingProfileId);
    if (!existing) return null;
    await tx.delete(routingProfiles).where(eq(routingProfiles.routingProfileId, routingProfileId));
    recordConfigChange({
      resource: 'routing_profile',
      action: 'delete',
      target: routingProfileId,
      actor,
      before: auditedFields('routing_profile', existing),
      after: null,
    });
    return existing;
  });
}

/**
 * The seed's idempotent upsert.
 *
 * `insertOnly` is the `$setOnInsert` half — defaults a re-run must not
 * overwrite — and `always` is the `$set` half. The mappings are ALWAYS replaced,
 * matching the source, which put `providerMappings` under `$set`.
 *
 * Returns whether a row was inserted, read off `xmax = 0`: Mongo answered that
 * with `upsertedCount` and Postgres has no such field.
 */
export async function upsertRoutingProfile(
  db: ApiDatabase,
  routingProfileId: string,
  insertOnly: RoutingProfileInput,
  always: RoutingProfileInput,
  mappings: ProviderMappingInput[],
  actor: ConfigAuditActor,
): Promise<{ inserted: boolean }> {
  // ADR 0002, same reservation as `createRoutingProfile`. All three identifiers are
  // checked, not just the parameter: `always.routingProfileId` reaches the
  // `onConflictDoUpdate` SET clause below, so an upsert can RENAME an existing
  // row's alias, and checking only the parameter would leave that route open.
  assertUnreservedModelIdentifier(routingProfileId);
  if (insertOnly.routingProfileId !== undefined) assertUnreservedModelIdentifier(insertOnly.routingProfileId);
  if (always.routingProfileId !== undefined) assertUnreservedModelIdentifier(always.routingProfileId);

  return db.transaction(async (tx) => {
    const previous = await findRoutingProfile(tx, routingProfileId);
    const insertColumns = {
      ...toColumns(insertOnly),
      ...toColumns(always),
      routingProfileId,
    } as typeof routingProfiles.$inferInsert;

    const [row] = await tx
      .insert(routingProfiles)
      .values(insertColumns)
      .onConflictDoUpdate({
        target: routingProfiles.routingProfileId,
        set: { ...toColumns(always), updatedAt: sql`date_trunc('milliseconds', now())` },
      })
      // The whole row, not just the id: the audit record's `after` has to be
      // what the statement actually wrote. `insertColumns` is what was ASKED
      // for, and on the conflict branch only `always` is applied — recording the
      // request instead of the result would report changes that did not happen.
      .returning({ ...getTableColumns(routingProfiles), inserted: sql<boolean>`(xmax = 0)` });

    await replaceProviderMappings(tx, row.id, mappings);
    recordConfigChange({
      resource: 'routing_profile',
      action: 'upsert',
      target: routingProfileId,
      actor,
      before: auditedFields('routing_profile', previous),
      after: auditedFields('routing_profile', row),
    });
    return { inserted: row.inserted };
  });
}

/**
 * Resolve `(provider, modelId)` pairs to `model_configs` ids in ONE query.
 *
 * The routes looked each mapping up in a loop. The pairs are matched together
 * rather than as two independent `IN` lists, because separate lists would accept
 * a cross-product — `openai/claude-opus` would resolve if both halves existed on
 * different rows, and the mapping would point at a model nobody asked for.
 */
export async function resolveModelConfigIds(
  db: Executor,
  pairs: { provider: string; modelId: string }[],
): Promise<Map<string, string>> {
  if (pairs.length === 0) return new Map();
  const tuples = sql.join(
    pairs.map((p) => sql`(${p.provider}, ${p.modelId})`),
    sql`, `,
  );
  const rows = await db
    .select({
      id: modelConfigs.id,
      provider: modelConfigs.provider,
      modelId: modelConfigs.modelId,
    })
    .from(modelConfigs)
    .where(sql`(${modelConfigs.provider}, ${modelConfigs.modelId}) in (${tuples})`);

  return new Map(rows.map((r) => [modelConfigKey(r.provider, r.modelId), r.id]));
}

/**
 * The key {@link resolveModelConfigIds} returns.
 *
 * Separated by an ESCAPED NUL rather than a literal one. A literal NUL byte in a
 * source file makes git treat the whole file as BINARY — it then merges with no
 * diff and every text-based gate reads it as clean, which is a documented way to
 * lose a change silently. The escape is the same character to the runtime and
 * plain text on disk.
 *
 * NUL rather than a space or a slash because model ids routinely contain both
 * (`@cf/meta/llama-3.2-11b-vision-instruct`), and a separator that can occur
 * inside either half lets two different pairs share one key.
 */
export function modelConfigKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`;
}

/**
 * Which of these alias ids exist.
 *
 * ## The source asked the WRONG FIELD, and it always answered nothing
 *
 * `plans.ts` validated a plan's `modelIds` with
 * `RoutingProfile.find({ modelId: { $in: ids } })`. `modelId` is a field on the
 * `providerMappings` SUB-DOCUMENT; the model itself has `routingProfileId` and no
 * top-level `modelId` at all, and a bare path in a Mongo filter does not reach
 * into a sub-document. So the query matched nothing, `validIds` was always
 * empty, and EVERY id was reported invalid — creating or updating a plan with a
 * non-empty `modelIds` returned 400 every time.
 *
 * That is not arbitrariness to reproduce, and it is not portable either: the
 * column does not exist, so the faithful version does not compile. The intent is
 * documented on `plans.modelIds` in `db/schema/billing.ts` ("the
 * `routing_profiles.routing_profile_id`s this plan includes") and confirmed by
 * `seed-plans.ts`, which fills the field with `kaana-v1-pro` and friends. This
 * asks about `routingProfileId`.
 *
 * BEHAVIOUR CHANGE, flagged: plans carrying valid alias ids will now be accepted
 * where they were previously rejected.
 */
export async function findExistingRoutingProfileIds(
  db: Executor,
  routingProfileIds: string[],
): Promise<Set<string>> {
  if (routingProfileIds.length === 0) return new Set();
  const rows = await db
    .select({ routingProfileId: routingProfiles.routingProfileId })
    .from(routingProfiles)
    .where(inArray(routingProfiles.routingProfileId, routingProfileIds));
  return new Set(rows.map((r) => r.routingProfileId));
}
