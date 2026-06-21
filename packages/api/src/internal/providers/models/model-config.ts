import mongoose, { Document, Schema } from 'mongoose';
import { PROVIDER_NAMES } from '../lib/provider-names.js';

export interface IModelCapabilities {
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

export interface IModelLimits {
  maxContextTokens: number;
  maxOutputTokens: number;
  maxImages?: number;
  maxAudioSeconds?: number;
}

export interface IModelPricing {
  tier: string;
  costPer1MInput: number;
  costPer1MOutput: number;
  costPer1MCachedInput?: number;
  averageLatencyMs: number;
}

export interface IDefaultConfig {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface IModelConfig extends Document {
  // Model Identity
  modelId: string;
  provider: string;
  displayName: string;

  // Alia Tier Mapping
  aliaTier?: string;
  priority?: number;
  qualityScore?: number;

  // Capabilities
  capabilities: IModelCapabilities;

  // Limits
  limits: IModelLimits;

  // Pricing
  pricing: IModelPricing;

  // Configuration Overrides
  defaultConfig?: IDefaultConfig;

  // Status
  isActive: boolean;
  isDeprecated: boolean;
  deprecationDate?: Date;
  replacementModelId?: string;

  // Metadata
  description?: string;
  providerUrl?: string;
  notes?: string;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

const ModelConfigSchema = new Schema<IModelConfig>(
  {
    modelId: {
      type: String,
      required: true,
    },
    provider: {
      type: String,
      required: true,
      enum: [...PROVIDER_NAMES],
      index: true,
    },
    displayName: {
      type: String,
      required: true,
    },
    aliaTier: {
      type: String,
      enum: [
        'lite',
        'v1',
        'v1-codea',
        'v1-cowork',
        'v1-browser',
        'v1-vision',
        'v1-audio',
        'v1-tts',
        'v1-multimodal',
        'v1-pro',
        'v1-pro-max',
        'v1-voice',
        'v1-voice-pro',
      ],
      index: true,
    },
    priority: {
      type: Number,
      min: 1,
      max: 100,
    },
    qualityScore: {
      type: Number,
      min: 0,
      max: 100,
    },
    capabilities: {
      vision: { type: Boolean, default: false },
      audio: { type: Boolean, default: false },
      codeExecution: { type: Boolean, default: false },
      webSearch: { type: Boolean, default: false },
      computerUse: { type: Boolean, default: false },
      thinking: { type: Boolean, default: false },
      streaming: { type: Boolean, default: true },
      functionCalling: { type: Boolean, default: true },
      jsonMode: { type: Boolean, default: false },
      promptCaching: { type: Boolean, default: false },
    },
    limits: {
      maxContextTokens: { type: Number, required: true },
      maxOutputTokens: { type: Number, required: true },
      maxImages: { type: Number },
      maxAudioSeconds: { type: Number },
    },
    pricing: {
      tier: {
        type: String,
        required: true,
        enum: ['free', 'freemium', 'paid'],
      },
      costPer1MInput: { type: Number, required: true },
      costPer1MOutput: { type: Number, required: true },
      costPer1MCachedInput: { type: Number },
      averageLatencyMs: { type: Number, required: true },
    },
    defaultConfig: {
      temperature: { type: Number },
      topP: { type: Number },
      maxTokens: { type: Number },
      systemPrompt: { type: String },
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isDeprecated: {
      type: Boolean,
      default: false,
      index: true,
    },
    deprecationDate: {
      type: Date,
    },
    replacementModelId: {
      type: String,
    },
    description: {
      type: String,
      maxlength: 1000,
    },
    providerUrl: {
      type: String,
      maxlength: 500,
    },
    notes: {
      type: String,
      maxlength: 2000,
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index
ModelConfigSchema.index({ provider: 1, modelId: 1 }, { unique: true });

// Additional indexes
ModelConfigSchema.index({ aliaTier: 1, priority: 1 });
ModelConfigSchema.index({ isActive: 1, isDeprecated: 1 });

export const ModelConfig = (mongoose.models.ModelConfig || mongoose.model<IModelConfig>('ModelConfig', ModelConfigSchema)) as mongoose.Model<IModelConfig>;
