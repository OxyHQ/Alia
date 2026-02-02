import { ExternalModel } from '../models/external-model.js';

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

function mapToDocument(m: ZeroEvalModel) {
  return {
    modelId: m.model_id,
    name: m.name,
    organization: m.organization,
    organizationId: m.organization_id,
    organizationCountry: m.organization_country || undefined,
    params: m.params,
    context: m.context,
    canonicalModelId: m.canonical_model_id,
    releaseDate: m.release_date,
    announcementDate: m.announcement_date,
    multimodal: m.multimodal,
    license: m.license || undefined,
    knowledgeCutoff: m.knowledge_cutoff,
    inputPrice: parseFloat_(m.input_price),
    outputPrice: parseFloat_(m.output_price),
    throughput: parseFloat_(m.throughput),
    latency: parseFloat_(m.latency),
    benchmarks: {
      aime2025: m.aime_2025_score,
      hle: m.hle_score,
      gpqa: m.gpqa_score,
      sweBenchVerified: m.swe_bench_verified_score,
      mmmu: m.mmmu_score,
      simpleqa: m.simpleqa_score,
      osworld: m.osworld_score,
      browsecomp: m.browsecomp_score,
      toolathlon: m.toolathlon_score,
      terminalBench: m.terminal_bench_score,
      tauBenchRetail: m.tau_bench_retail_score,
      arcAgiV2: m.arc_agi_v2_score,
      mmmlu: m.mmmlu_score,
      charxivR: m.charxiv_r_score,
      mmmuPro: m.mmmu_pro_score,
      screenspotPro: m.screenspot_pro_score,
      mcpAtlas: m.mcp_atlas_score,
      frontiermath: m.frontiermath_score,
    },
    source: 'zeroeval',
    lastSyncedAt: new Date(),
  };
}

export async function syncZeroEval(): Promise<void> {
  try {
    console.log('[ZeroEval] Fetching models from ZeroEval API...');

    const response = await fetch(ZEROEVAL_URL);
    if (!response.ok) {
      console.error(`[ZeroEval] API returned ${response.status}: ${response.statusText}`);
      return;
    }

    const models = (await response.json()) as ZeroEvalModel[];
    console.log(`[ZeroEval] Received ${models.length} models, upserting...`);

    const bulkOps = models.map((m) => ({
      updateOne: {
        filter: { modelId: m.model_id },
        update: { $set: mapToDocument(m) },
        upsert: true,
      },
    }));

    const result = await ExternalModel.bulkWrite(bulkOps, { ordered: false });
    console.log(
      `[ZeroEval] Sync complete: ${result.upsertedCount} inserted, ${result.modifiedCount} updated, ${models.length} total`
    );
  } catch (error) {
    console.error('[ZeroEval] Sync failed:', error);
  }
}
