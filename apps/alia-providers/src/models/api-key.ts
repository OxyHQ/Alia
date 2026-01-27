import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IApiKey extends Document {
  provider: string;
  modelId: string;
  key: string;
  isPaid: boolean;
  rpm?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ApiKeySchema = new Schema<IApiKey>({
  provider: { type: String, required: true },
  modelId: { type: String, required: true },
  key: { type: String, required: true, unique: true },
  isPaid: { type: Boolean, default: false },
  rpm: { type: Number },
  rpd: { type: Number },
  tpm: { type: Number },
  tpd: { type: Number },
  isActive: { type: Boolean, default: true }
}, {
  timestamps: true
});

export const ApiKey: Model<IApiKey> = mongoose.models.ApiKey || mongoose.model<IApiKey>('ApiKey', ApiKeySchema);
