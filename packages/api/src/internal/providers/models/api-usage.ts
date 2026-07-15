import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IApiUsage extends Document {
  keyId: mongoose.Types.ObjectId;
  provider: string;
  modelId: string;
  tokens: number;
  timestamp: Date;
}

const ApiUsageSchema = new Schema<IApiUsage>({
  keyId: { type: Schema.Types.ObjectId, ref: 'ProviderKey', required: true, index: true },
  provider: { type: String, required: true, index: true },
  modelId: { type: String, required: true },
  tokens: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now }
});

// Índice compuesto para búsquedas rápidas por rango de tiempo y key
ApiUsageSchema.index({ keyId: 1, timestamp: -1 });

// TTL: auto-delete after 48h. Rate-limit checks (key-manager) only ever read the
// last 24h window, so a 48h retention leaves a safe margin. This index also serves
// standalone timestamp range queries, replacing the former plain timestamp index.
ApiUsageSchema.index({ timestamp: 1 }, { expireAfterSeconds: 48 * 60 * 60 });

export const ApiUsage = (mongoose.models.ApiUsage || mongoose.model<IApiUsage>('ApiUsage', ApiUsageSchema)) as Model<IApiUsage>;
