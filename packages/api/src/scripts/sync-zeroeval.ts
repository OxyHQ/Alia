import {
  upsertExternalModels,
  type ExternalModelUpsert,
} from '../db/providers/externalModelRepository.js';
import { getDb } from '../db/index.js';
import { log } from '../lib/logger.js';

const ZEROEVAL_URL = 'https://api.zeroeval.com/leaderboard/models/full?justCanonicals=true';

interface ZeroEvalModel {
  model_id: string;
  name: string;
  organization: string;
  organization_id: string;
  organization_country: string | null;
  params: number | null;
  context: number | null;
  canonical_model_id: string | null;
  release_date: string | null;
  announcement_date: string | null;
  multimodal: boolean;
  license: string | null;
  knowledge_cutoff: string | null;
  input_price: string | null;
  output_price: string | null;
  throughput: string | null;
  latency: string | null;
  aime_2025_score: number | null;
  hle_score: number | null;
  gpqa_score: number | null;
  swe_bench_verified_score: number | null;
  mmmu_score: number | null;
  simpleqa_score: number | null;
  osworld_score: number | null;
  browsecomp_score: number | null;
  toolathlon_score: number | null;
  terminal_bench_score: number | null;
  tau_bench_retail_score: number | null;
  arc_agi_v2_score: number | null;
  mmmlu_score: number | null;
  charxiv_r_score: number | null;
  mmmu_pro_score: number | null;
  screenspot_pro_score: number | null;
  mcp_atlas_score: number | null;
  frontiermath_score: number | null;
}

function parseFloat_(val: string | null): number | null {
  if (val === null || val === undefined) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

/**
 * One upstream record, flattened into columns.
 *
 * The eighteen benchmarks were a nested `benchmarks` sub-document in Mongo and
 * are columns here, so the mapper flattens rather than nests. `undefined` became
 * an explicit `null` for the same reason: a multi-row `VALUES` has to name the
 * same columns for every row, and an omitted key would shift the shape.
 */
function mapToRow(m: ZeroEvalModel): ExternalModelUpsert {
  return {
    modelId: m.model_id,
    name: m.name,
    organization: m.organization,
    organizationId: m.organization_id,
    organizationCountry: m.organization_country ?? null,
    params: m.params,
    context: m.context,
    canonicalModelId: m.canonical_model_id,
    releaseDate: m.release_date,
    announcementDate: m.announcement_date,
    multimodal: m.multimodal,
    license: m.license ?? null,
    knowledgeCutoff: m.knowledge_cutoff,
    inputPrice: parseFloat_(m.input_price),
    outputPrice: parseFloat_(m.output_price),
    throughput: parseFloat_(m.throughput),
    latency: parseFloat_(m.latency),
    benchmarkAime2025: m.aime_2025_score,
    benchmarkHle: m.hle_score,
    benchmarkGpqa: m.gpqa_score,
    benchmarkSweBenchVerified: m.swe_bench_verified_score,
    benchmarkMmmu: m.mmmu_score,
    benchmarkSimpleqa: m.simpleqa_score,
    benchmarkOsworld: m.osworld_score,
    benchmarkBrowsecomp: m.browsecomp_score,
    benchmarkToolathlon: m.toolathlon_score,
    benchmarkTerminalBench: m.terminal_bench_score,
    benchmarkTauBenchRetail: m.tau_bench_retail_score,
    benchmarkArcAgiV2: m.arc_agi_v2_score,
    benchmarkMmmlu: m.mmmlu_score,
    benchmarkCharxivR: m.charxiv_r_score,
    benchmarkMmmuPro: m.mmmu_pro_score,
    benchmarkScreenspotPro: m.screenspot_pro_score,
    benchmarkMcpAtlas: m.mcp_atlas_score,
    benchmarkFrontiermath: m.frontiermath_score,
    source: 'zeroeval',
    lastSyncedAt: new Date(),
  };
}

export async function syncZeroEval(): Promise<void> {
  try {
    log.general.info('Fetching models from ZeroEval API');

    const response = await fetch(ZEROEVAL_URL);
    if (!response.ok) {
      log.general.error({ status: response.status, statusText: response.statusText }, 'ZeroEval API error');
      return;
    }

    const models = (await response.json()) as ZeroEvalModel[];
    log.general.info({ count: models.length }, 'ZeroEval models received, upserting');

    // One statement with a multi-row VALUES, where this was an unordered
    // `bulkWrite` of N `updateOne`s. `updated` is no longer reported: Mongo's
    // `modifiedCount` excluded rows a re-sync left byte-identical and Postgres
    // has no equivalent, so inventing one from `total - inserted` would silently
    // change what the number means.
    const result = await upsertExternalModels(getDb(), models.map(mapToRow));
    log.general.info({ inserted: result.inserted, total: result.total }, 'ZeroEval sync complete');
  } catch (error) {
    log.general.error({ err: error }, 'ZeroEval sync failed');
  }
}
