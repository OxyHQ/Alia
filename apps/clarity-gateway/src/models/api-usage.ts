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
  timestamp: { type: Date, default: Date.now, index: true }
});

// Índice compuesto para búsquedas rápidas por rango de tiempo y key
ApiUsageSchema.index({ keyId: 1, timestamp: -1 });

export const ApiUsage: Model<IApiUsage> = mongoose.models.ApiUsage || mongoose.model<IApiUsage>('ApiUsage', ApiUsageSchema);
