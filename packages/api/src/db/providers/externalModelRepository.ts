/**
 * A third party's public model leaderboard, mirrored, on Postgres.
 *
 * NOT the routing catalogue and never to be joined to one: `model_configs` is
 * what this service can actually call. `scripts/sync-zeroeval.ts` writes this
 * table and `routes/external-models.ts` serves it; nothing in the completion
 * path reads it.
 *
 * ## The eighteen benchmarks are COLUMNS, and the wire shape nests them
 *
 * The read path filters on four benchmarks being non-null and sorts by two, so
 * they have a queryable identity that `jsonb` would hide. The API serves them
 * under `benchmarks.*`, which is what the client reads, so the reads rebuild
 * that object.
 */

import { and, asc, desc, eq, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../index';
import {
  recordConfigChange,
  type ConfigAuditActor,
} from '../../lib/security/config-audit.js';
import { externalModels } from '../schema/providers';

export type ExternalModelRow = typeof externalModels.$inferSelect;

export interface ExternalBenchmarks {
  aime2025: number | null;
  hle: number | null;
  gpqa: number | null;
  sweBenchVerified: number | null;
  mmmu: number | null;
  simpleqa: number | null;
  osworld: number | null;
  browsecomp: number | null;
  toolathlon: number | null;
  terminalBench: number | null;
  tauBenchRetail: number | null;
  arcAgiV2: number | null;
  mmmlu: number | null;
  charxivR: number | null;
  mmmuPro: number | null;
  screenspotPro: number | null;
  mcpAtlas: number | null;
  frontiermath: number | null;
}

export interface ExternalModelView {
  _id: string;
  id: string;
  modelId: string;
  name: string;
  organization: string;
  organizationId: string;
  organizationCountry: string | null;
  params: number | null;
  context: number | null;
  canonicalModelId: string | null;
  releaseDate: string | null;
  announcementDate: string | null;
  multimodal: boolean;
  license: string | null;
  knowledgeCutoff: string | null;
  inputPrice: number | null;
  outputPrice: number | null;
  throughput: number | null;
  latency: number | null;
  benchmarks: ExternalBenchmarks;
  source: string;
  lastSyncedAt: Date;
}

function toView(row: ExternalModelRow): ExternalModelView {
  return {
    _id: row.id,
    id: row.id,
    modelId: row.modelId,
    name: row.name,
    organization: row.organization,
    organizationId: row.organizationId,
    organizationCountry: row.organizationCountry,
    params: row.params,
    context: row.context,
    canonicalModelId: row.canonicalModelId,
    releaseDate: row.releaseDate,
    announcementDate: row.announcementDate,
    multimodal: row.multimodal,
    license: row.license,
    knowledgeCutoff: row.knowledgeCutoff,
    inputPrice: row.inputPrice,
    outputPrice: row.outputPrice,
    throughput: row.throughput,
    latency: row.latency,
    benchmarks: {
      aime2025: row.benchmarkAime2025,
      hle: row.benchmarkHle,
      gpqa: row.benchmarkGpqa,
      sweBenchVerified: row.benchmarkSweBenchVerified,
      mmmu: row.benchmarkMmmu,
      simpleqa: row.benchmarkSimpleqa,
      osworld: row.benchmarkOsworld,
      browsecomp: row.benchmarkBrowsecomp,
      toolathlon: row.benchmarkToolathlon,
      terminalBench: row.benchmarkTerminalBench,
      tauBenchRetail: row.benchmarkTauBenchRetail,
      arcAgiV2: row.benchmarkArcAgiV2,
      mmmlu: row.benchmarkMmmlu,
      charxivR: row.benchmarkCharxivR,
      mmmuPro: row.benchmarkMmmuPro,
      screenspotPro: row.benchmarkScreenspotPro,
      mcpAtlas: row.benchmarkMcpAtlas,
      frontiermath: row.benchmarkFrontiermath,
    },
    source: row.source,
    lastSyncedAt: row.lastSyncedAt,
  };
}

export type ExternalModelSort = 'gpqa' | 'swe' | 'mmmlu' | 'release' | 'price' | 'default';

export interface ListExternalModelsFilter {
  organizationId?: string;
  multimodal?: boolean;
  hasBenchmarks?: boolean;
  sort?: ExternalModelSort;
}

/**
 * The leaderboard read.
 *
 * Every descending sort says `NULLS LAST`. Postgres puts nulls FIRST under
 * `DESC`, so without it a model with no GPQA score heads a list ordered by GPQA
 * — the highest-scoring position, occupied by the models that have no score at
 * all. Mongo sorted nulls last under `-1`, so this also keeps the existing
 * behaviour rather than merely being sensible.
 */
export async function listExternalModels(
  db: Executor,
  filter: ListExternalModelsFilter,
): Promise<ExternalModelView[]> {
  const orderBy: SQL[] = [];
  switch (filter.sort) {
    case 'gpqa':
      orderBy.push(sql`${externalModels.benchmarkGpqa} desc nulls last`);
      break;
    case 'swe':
      orderBy.push(sql`${externalModels.benchmarkSweBenchVerified} desc nulls last`);
      break;
    case 'mmmlu':
      orderBy.push(sql`${externalModels.benchmarkMmmlu} desc nulls last`);
      break;
    case 'release':
      orderBy.push(sql`${externalModels.releaseDate} desc nulls last`);
      break;
    case 'price':
      // Ascending: cheapest first. Nulls last again — an unpriced model is not
      // the cheapest one.
      orderBy.push(sql`${externalModels.inputPrice} asc nulls last`);
      break;
    default:
      orderBy.push(asc(externalModels.organizationId), asc(externalModels.name));
  }
  // A deterministic tie-break, so two calls with the same sort agree.
  orderBy.push(asc(externalModels.id));

  const rows = await db
    .select()
    .from(externalModels)
    .where(
      and(
        filter.organizationId ? eq(externalModels.organizationId, filter.organizationId) : undefined,
        filter.multimodal ? eq(externalModels.multimodal, true) : undefined,
        // The same four the source tested, in the same order.
        filter.hasBenchmarks
          ? or(
              isNotNull(externalModels.benchmarkGpqa),
              isNotNull(externalModels.benchmarkSweBenchVerified),
              isNotNull(externalModels.benchmarkMmmu),
              isNotNull(externalModels.benchmarkMmmlu),
            )
          : undefined,
      ),
    )
    .orderBy(...orderBy);
  return rows.map(toView);
}

export async function findExternalModel(
  db: Executor,
  modelId: string,
): Promise<ExternalModelView | null> {
  const [row] = await db.select().from(externalModels).where(eq(externalModels.modelId, modelId));
  return row ? toView(row) : null;
}

export interface ExternalOrganization {
  _id: string;
  name: string;
  country: string | null;
  modelCount: number;
}

/**
 * The organizations, with how many models each publishes.
 *
 * `name` and `country` were `$first` in the Mongo pipeline with no `$sort`,
 * which is the arbitrary-pick shape this port has refused elsewhere. They are
 * `min()` here — deterministic, and identical whenever an organization's rows
 * agree on them, which they do because both are copied from the same upstream
 * record. `_id` is the group key name the client destructures.
 */
export async function listExternalOrganizations(
  db: Executor,
): Promise<ExternalOrganization[]> {
  return db
    .select({
      _id: externalModels.organizationId,
      name: sql<string>`min(${externalModels.organization})`,
      country: sql<string | null>`min(${externalModels.organizationCountry})`,
      modelCount: sql<number>`count(*)::int`,
    })
    .from(externalModels)
    .groupBy(externalModels.organizationId)
    .orderBy(desc(sql`count(*)`), asc(externalModels.organizationId));
}

export type ExternalModelUpsert = Omit<
  typeof externalModels.$inferInsert,
  'id' | 'createdAt' | 'updatedAt'
>;

/**
 * The sync's bulk upsert, keyed on `model_id`.
 *
 * ONE statement with a multi-row `VALUES`, where the source issued an unordered
 * `bulkWrite` of N `updateOne`s. The counts it logged do not survive: Mongo
 * reported `upsertedCount` and `modifiedCount` separately and Postgres reports
 * neither, so this returns how many rows were INSERTED (via `xmax = 0`) and the
 * total touched, and the caller logs those instead of inventing the old pair.
 */
export async function upsertExternalModels(
  db: Executor,
  models: ExternalModelUpsert[],
  actor: ConfigAuditActor,
): Promise<{ inserted: number; total: number }> {
  if (models.length === 0) return { inserted: 0, total: 0 };

  const rows = await db
    .insert(externalModels)
    .values(models)
    .onConflictDoUpdate({
      target: externalModels.modelId,
      set: {
        // Spelled out rather than interpolated: `excluded.<col>` built from a
        // drizzle column object emits the JS PROPERTY name, so a camelCase
        // column becomes `excluded.modelid` and fails with 42703 at runtime.
        name: sql`excluded.name`,
        organization: sql`excluded.organization`,
        organizationId: sql`excluded.organization_id`,
        organizationCountry: sql`excluded.organization_country`,
        params: sql`excluded.params`,
        context: sql`excluded.context`,
        canonicalModelId: sql`excluded.canonical_model_id`,
        releaseDate: sql`excluded.release_date`,
        announcementDate: sql`excluded.announcement_date`,
        multimodal: sql`excluded.multimodal`,
        license: sql`excluded.license`,
        knowledgeCutoff: sql`excluded.knowledge_cutoff`,
        inputPrice: sql`excluded.input_price`,
        outputPrice: sql`excluded.output_price`,
        throughput: sql`excluded.throughput`,
        latency: sql`excluded.latency`,
        benchmarkAime2025: sql`excluded.benchmark_aime_2025`,
        benchmarkHle: sql`excluded.benchmark_hle`,
        benchmarkGpqa: sql`excluded.benchmark_gpqa`,
        benchmarkSweBenchVerified: sql`excluded.benchmark_swe_bench_verified`,
        benchmarkMmmu: sql`excluded.benchmark_mmmu`,
        benchmarkSimpleqa: sql`excluded.benchmark_simpleqa`,
        benchmarkOsworld: sql`excluded.benchmark_osworld`,
        benchmarkBrowsecomp: sql`excluded.benchmark_browsecomp`,
        benchmarkToolathlon: sql`excluded.benchmark_toolathlon`,
        benchmarkTerminalBench: sql`excluded.benchmark_terminal_bench`,
        benchmarkTauBenchRetail: sql`excluded.benchmark_tau_bench_retail`,
        benchmarkArcAgiV2: sql`excluded.benchmark_arc_agi_v2`,
        benchmarkMmmlu: sql`excluded.benchmark_mmmlu`,
        benchmarkCharxivR: sql`excluded.benchmark_charxiv_r`,
        benchmarkMmmuPro: sql`excluded.benchmark_mmmu_pro`,
        benchmarkScreenspotPro: sql`excluded.benchmark_screenspot_pro`,
        benchmarkMcpAtlas: sql`excluded.benchmark_mcp_atlas`,
        benchmarkFrontiermath: sql`excluded.benchmark_frontiermath`,
        source: sql`excluded.source`,
        lastSyncedAt: sql`excluded.last_synced_at`,
        updatedAt: sql`date_trunc('milliseconds', now())`,
      },
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });

  const inserted = rows.filter((r) => r.inserted).length;
  // ONE record for the whole sync, not one per model. This is a bulk import
  // from an external catalogue: the FACT a person would audit is "a sync ran,
  // by whom, and how much it touched", and 400 per-row records would bury it.
  // A per-row diff is available from the source data if it is ever wanted.
  recordConfigChange({
    resource: 'external_model',
    action: 'upsert',
    target: `sync:${String(rows.length)} rows, ${String(inserted)} new`,
    actor,
    before: null,
    after: null,
  });
  return { inserted, total: rows.length };
}
