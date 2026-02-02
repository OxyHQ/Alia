import mongoose, { Document, Schema } from 'mongoose';

export interface IBenchmarks {
  aime2025?: number | null;
  hle?: number | null;
  gpqa?: number | null;
  sweBenchVerified?: number | null;
  mmmu?: number | null;
  simpleqa?: number | null;
  osworld?: number | null;
  browsecomp?: number | null;
  toolathlon?: number | null;
  terminalBench?: number | null;
  tauBenchRetail?: number | null;
  arcAgiV2?: number | null;
  mmmlu?: number | null;
  charxivR?: number | null;
  mmmuPro?: number | null;
  screenspotPro?: number | null;
  mcpAtlas?: number | null;
  frontiermath?: number | null;
}

export interface IExternalModel extends Document {
  modelId: string;
  name: string;
  organization: string;
  organizationId: string;
  organizationCountry?: string;
  params?: number | null;
  context?: number | null;
  canonicalModelId?: string | null;
  releaseDate?: string | null;
  announcementDate?: string | null;
  multimodal: boolean;
  license?: string;
  knowledgeCutoff?: string | null;
  inputPrice?: number | null;
  outputPrice?: number | null;
  throughput?: number | null;
  latency?: number | null;
  benchmarks: IBenchmarks;
  source: string;
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const BenchmarksSchema = new Schema({
  aime2025: { type: Number, default: null },
  hle: { type: Number, default: null },
  gpqa: { type: Number, default: null },
  sweBenchVerified: { type: Number, default: null },
  mmmu: { type: Number, default: null },
  simpleqa: { type: Number, default: null },
  osworld: { type: Number, default: null },
  browsecomp: { type: Number, default: null },
  toolathlon: { type: Number, default: null },
  terminalBench: { type: Number, default: null },
  tauBenchRetail: { type: Number, default: null },
  arcAgiV2: { type: Number, default: null },
  mmmlu: { type: Number, default: null },
  charxivR: { type: Number, default: null },
  mmmuPro: { type: Number, default: null },
  screenspotPro: { type: Number, default: null },
  mcpAtlas: { type: Number, default: null },
  frontiermath: { type: Number, default: null },
}, { _id: false });

const ExternalModelSchema = new Schema<IExternalModel>(
  {
    modelId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    organization: { type: String, required: true },
    organizationId: { type: String, required: true, index: true },
    organizationCountry: { type: String },
    params: { type: Number, default: null },
    context: { type: Number, default: null },
    canonicalModelId: { type: String, default: null },
    releaseDate: { type: String, default: null },
    announcementDate: { type: String, default: null },
    multimodal: { type: Boolean, default: false },
    license: { type: String },
    knowledgeCutoff: { type: String, default: null },
    inputPrice: { type: Number, default: null },
    outputPrice: { type: Number, default: null },
    throughput: { type: Number, default: null },
    latency: { type: Number, default: null },
    benchmarks: { type: BenchmarksSchema, default: () => ({}) },
    source: { type: String, default: 'zeroeval' },
    lastSyncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

ExternalModelSchema.index({ organizationId: 1, modelId: 1 });
ExternalModelSchema.index({ source: 1 });

export const ExternalModel = mongoose.models.ExternalModel || mongoose.model<IExternalModel>('ExternalModel', ExternalModelSchema);
