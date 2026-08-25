/**
 * The routing catalogue's provider models, on Postgres.
 *
 * ## The TABLE is flat and the WIRE SHAPE is nested
 *
 * `capabilities`, `limits`, `pricing` and `defaultConfig` were Mongoose
 * sub-documents and are real columns here, per the `routing_logs` precedent —
 * fixed shapes this service owns, which `jsonb` would only hide from a CHECK and
 * from the planner. But the admin routes serve these documents straight to a
 * client that reads `model.capabilities.vision` and `model.pricing.tier`, so the
 * reads rebuild the nested shape and that reconstruction is the contract.
 *
 * `_id` is served alongside `id` for the same reason: it is what the Mongo
 * documents carried and what a shipped client may key on.
 */

import { and, asc, eq, getTableColumns, sql } from 'drizzle-orm';
import type { Executor } from '../index';
import {
  auditedFields,
  recordConfigChange,
  type ConfigAuditActor,
} from '../../lib/security/config-audit.js';
import { modelConfigs } from '../schema/providers';

export type ModelConfigRow = typeof modelConfigs.$inferSelect;

export interface ModelCapabilities {
  vision: boolean;
  audio: boolean;
  codeExecution: boolean;
  webSearch: boolean;
  computerUse: boolean;
  thinking: boolean;
  streaming: boolean;
  functionCalling: boolean;
  jsonMode: boolean;
  promptCaching: boolean;
}

export interface ModelLimits {
  maxContextTokens: number;
  maxOutputTokens: number;
  maxImages: number | null;
  maxAudioSeconds: number | null;
}

export interface ModelPricing {
  tier: string;
  costPer1MInput: number;
  costPer1MOutput: number;
  costPer1MCachedInput: number | null;
  averageLatencyMs: number;
}

export interface ModelDefaultConfig {
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  systemPrompt: string | null;
}

/** The nested JSON shape the admin clients consume. Do not flatten this. */
export interface ModelConfigView {
  _id: string;
  id: string;
  modelId: string;
  provider: string;
  displayName: string;
  priority: number | null;
  qualityScore: number | null;
  capabilities: ModelCapabilities;
  limits: ModelLimits;
  pricing: ModelPricing;
  defaultConfig: ModelDefaultConfig;
  isActive: boolean;
  isDeprecated: boolean;
  deprecationDate: Date | null;
  replacementModelId: string | null;
  description: string | null;
  providerUrl: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toModelConfigView(row: ModelConfigRow): ModelConfigView {
  return {
    _id: row.id,
    id: row.id,
    modelId: row.modelId,
    provider: row.provider,
    displayName: row.displayName,
    priority: row.priority,
    qualityScore: row.qualityScore,
    capabilities: {
      vision: row.capabilitiesVision,
      audio: row.capabilitiesAudio,
      codeExecution: row.capabilitiesCodeExecution,
      webSearch: row.capabilitiesWebSearch,
      computerUse: row.capabilitiesComputerUse,
      thinking: row.capabilitiesThinking,
      streaming: row.capabilitiesStreaming,
      functionCalling: row.capabilitiesFunctionCalling,
      jsonMode: row.capabilitiesJsonMode,
      promptCaching: row.capabilitiesPromptCaching,
    },
    limits: {
      maxContextTokens: row.limitsMaxContextTokens,
      maxOutputTokens: row.limitsMaxOutputTokens,
      maxImages: row.limitsMaxImages,
      maxAudioSeconds: row.limitsMaxAudioSeconds,
    },
    pricing: {
      tier: row.pricingTier,
      costPer1MInput: row.pricingCostPer1mInput,
      costPer1MOutput: row.pricingCostPer1mOutput,
      costPer1MCachedInput: row.pricingCostPer1mCachedInput,
      averageLatencyMs: row.pricingAverageLatencyMs,
    },
    defaultConfig: {
      temperature: row.defaultConfigTemperature,
      topP: row.defaultConfigTopP,
      maxTokens: row.defaultConfigMaxTokens,
      systemPrompt: row.defaultConfigSystemPrompt,
    },
    isActive: row.isActive,
    isDeprecated: row.isDeprecated,
    deprecationDate: row.deprecationDate,
    replacementModelId: row.replacementModelId,
    description: row.description,
    providerUrl: row.providerUrl,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The nested input an admin PATCH or POST supplies. */
export interface ModelConfigInput {
  modelId?: string;
  provider?: string;
  displayName?: string;
  priority?: number | null;
  qualityScore?: number | null;
  capabilities?: Partial<ModelCapabilities>;
  limits?: Partial<ModelLimits>;
  pricing?: Partial<ModelPricing>;
  defaultConfig?: Partial<ModelDefaultConfig>;
  isActive?: boolean;
  isDeprecated?: boolean;
  deprecationDate?: Date | null;
  replacementModelId?: string | null;
  description?: string | null;
  providerUrl?: string | null;
  notes?: string | null;
}

/**
 * Flatten a nested input into columns, omitting anything the caller did not
 * supply.
 *
 * A PATCH must not overwrite a sub-document's untouched siblings, which is what
 * a naive `capabilities: {...}` spread would do. Each leaf is copied only when
 * present, so `{capabilities: {vision: true}}` leaves the other nine alone —
 * matching Mongoose's dotted `$set` on a sub-document path.
 */
function toColumns(input: ModelConfigInput): Partial<typeof modelConfigs.$inferInsert> {
  const out: Partial<typeof modelConfigs.$inferInsert> = {};
  const put = <K extends keyof typeof out>(key: K, value: (typeof out)[K] | undefined) => {
    if (value !== undefined) out[key] = value;
  };

  put('modelId', input.modelId);
  put('provider', input.provider);
  put('displayName', input.displayName);
  put('priority', input.priority);
  put('qualityScore', input.qualityScore);

  put('capabilitiesVision', input.capabilities?.vision);
  put('capabilitiesAudio', input.capabilities?.audio);
  put('capabilitiesCodeExecution', input.capabilities?.codeExecution);
  put('capabilitiesWebSearch', input.capabilities?.webSearch);
  put('capabilitiesComputerUse', input.capabilities?.computerUse);
  put('capabilitiesThinking', input.capabilities?.thinking);
  put('capabilitiesStreaming', input.capabilities?.streaming);
  put('capabilitiesFunctionCalling', input.capabilities?.functionCalling);
  put('capabilitiesJsonMode', input.capabilities?.jsonMode);
  put('capabilitiesPromptCaching', input.capabilities?.promptCaching);

  put('limitsMaxContextTokens', input.limits?.maxContextTokens);
  put('limitsMaxOutputTokens', input.limits?.maxOutputTokens);
  put('limitsMaxImages', input.limits?.maxImages);
  put('limitsMaxAudioSeconds', input.limits?.maxAudioSeconds);

  put('pricingTier', input.pricing?.tier);
  put('pricingCostPer1mInput', input.pricing?.costPer1MInput);
  put('pricingCostPer1mOutput', input.pricing?.costPer1MOutput);
  put('pricingCostPer1mCachedInput', input.pricing?.costPer1MCachedInput);
  put('pricingAverageLatencyMs', input.pricing?.averageLatencyMs);

  put('defaultConfigTemperature', input.defaultConfig?.temperature);
  put('defaultConfigTopP', input.defaultConfig?.topP);
  put('defaultConfigMaxTokens', input.defaultConfig?.maxTokens);
  put('defaultConfigSystemPrompt', input.defaultConfig?.systemPrompt);

  put('isActive', input.isActive);
  put('isDeprecated', input.isDeprecated);
  put('deprecationDate', input.deprecationDate);
  put('replacementModelId', input.replacementModelId);
  put('description', input.description);
  put('providerUrl', input.providerUrl);
  put('notes', input.notes);
  return out;
}

export interface ListModelConfigsFilter {
  provider?: string;
  isActive?: boolean;
  isDeprecated?: boolean;
}

/**
 * The admin list.
 *
 * `priority` is nullable — a provider model serving no tier has none — so the
 * ordering says `NULLS LAST` explicitly. Without it Postgres sorts nulls FIRST
 * under `ASC`, putting every unmapped model at the head of a list ordered by
 * routing preference, which is the opposite of what the column means.
 */
export async function listModelConfigs(
  db: Executor,
  filter: ListModelConfigsFilter,
): Promise<ModelConfigView[]> {
  const rows = await db
    .select()
    .from(modelConfigs)
    .where(
      and(
        filter.provider ? eq(modelConfigs.provider, filter.provider) : undefined,
        filter.isActive !== undefined ? eq(modelConfigs.isActive, filter.isActive) : undefined,
        filter.isDeprecated !== undefined
          ? eq(modelConfigs.isDeprecated, filter.isDeprecated)
          : undefined,
      ),
    )
    .orderBy(asc(modelConfigs.provider), sql`${modelConfigs.priority} asc nulls last`, asc(modelConfigs.id));
  return rows.map(toModelConfigView);
}

export async function findModelConfig(
  db: Executor,
  provider: string,
  modelId: string,
): Promise<ModelConfigView | null> {
  const [row] = await db
    .select()
    .from(modelConfigs)
    .where(and(eq(modelConfigs.provider, provider), eq(modelConfigs.modelId, modelId)));
  return row ? toModelConfigView(row) : null;
}

export async function createModelConfig(
  db: Executor,
  input: ModelConfigInput,
  actor: ConfigAuditActor,
): Promise<ModelConfigView> {
  const columns = toColumns(input);
  const [row] = await db
    .insert(modelConfigs)
    .values(columns as typeof modelConfigs.$inferInsert)
    .returning();
  const view = toModelConfigView(row);
  recordConfigChange({
    resource: 'model_config',
    action: 'create',
    target: `${view.provider}/${view.modelId}`,
    actor,
    before: null,
    after: auditedFields('model_config', view),
  });
  return view;
}

export async function updateModelConfig(
  db: Executor,
  provider: string,
  modelId: string,
  input: ModelConfigInput,
  actor: ConfigAuditActor,
): Promise<ModelConfigView | null> {
  // Read BEFORE the write, so the record's `before` is the state this statement
  // replaced rather than whatever the row held whenever a second query ran.
  const previous = await findModelConfig(db, provider, modelId);
  const columns = toColumns(input);
  // The route strips `provider` and `modelId` before calling; stripping them
  // again here means the identity cannot move even if a caller forgets.
  delete columns.provider;
  delete columns.modelId;

  const [row] = await db
    .update(modelConfigs)
    .set({ ...columns, updatedAt: sql`date_trunc('milliseconds', now())` })
    .where(and(eq(modelConfigs.provider, provider), eq(modelConfigs.modelId, modelId)))
    .returning();
  if (!row) return null;
  const view = toModelConfigView(row);
  recordConfigChange({
    resource: 'model_config',
    action: 'update',
    target: `${provider}/${modelId}`,
    actor,
    before: auditedFields('model_config', previous),
    after: auditedFields('model_config', view),
  });
  return view;
}

export async function deleteModelConfig(
  db: Executor,
  provider: string,
  modelId: string,
  actor: ConfigAuditActor,
): Promise<ModelConfigView | null> {
  const [row] = await db
    .delete(modelConfigs)
    .where(and(eq(modelConfigs.provider, provider), eq(modelConfigs.modelId, modelId)))
    .returning();
  if (!row) return null;
  const view = toModelConfigView(row);
  recordConfigChange({
    resource: 'model_config',
    action: 'delete',
    target: `${provider}/${modelId}`,
    actor,
    before: auditedFields('model_config', view),
    after: null,
  });
  return view;
}

/**
 * The seed's idempotent upsert.
 *
 * `insertOnly` carries what the source put under `$setOnInsert` — the defaults a
 * re-run must NOT overwrite, because an operator may have tuned them — and
 * `always` carries the `$set` half, the tier mapping the seed owns. Keeping them
 * apart is the whole point: collapsing them would silently revert every manual
 * pricing or capability edit on the next deploy.
 *
 * Returns whether a row was INSERTED. Mongo answered that with `upsertedCount`;
 * Postgres has no such field, and `xmax = 0` is the documented way to ask — it
 * is zero exactly when the tuple was created by this statement rather than
 * updated by it.
 */
export async function upsertModelConfig(
  db: Executor,
  key: { provider: string; modelId: string },
  insertOnly: ModelConfigInput,
  always: ModelConfigInput,
  actor: ConfigAuditActor,
): Promise<{ inserted: boolean }> {
  const previous = await findModelConfig(db, key.provider, key.modelId);
  const insertColumns = { ...toColumns(insertOnly), ...toColumns(always), ...key };
  const updateColumns = toColumns(always);

  const rows = await db
    .insert(modelConfigs)
    .values(insertColumns as typeof modelConfigs.$inferInsert)
    .onConflictDoUpdate({
      target: [modelConfigs.provider, modelConfigs.modelId],
      set: { ...updateColumns, updatedAt: sql`date_trunc('milliseconds', now())` },
    })
    // The whole row beside the flag: the audit record's `after` must be what
    // the statement wrote, and on the conflict branch only `always` applies.
    .returning({ ...getTableColumns(modelConfigs), inserted: sql<boolean>`(xmax = 0)` });

  const written = rows[0];
  if (written !== undefined) {
    recordConfigChange({
      resource: 'model_config',
      action: 'upsert',
      target: `${key.provider}/${key.modelId}`,
      actor,
      before: auditedFields('model_config', previous),
      after: auditedFields('model_config', toModelConfigView(written)),
    });
  }
  return { inserted: written?.inserted ?? false };
}
