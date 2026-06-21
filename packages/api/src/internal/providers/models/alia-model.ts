import mongoose, { Document, Schema } from 'mongoose';

/**
 * AliaModel - Virtual Alia models (alia-v1, alia-lite, etc.)
 * Each Alia model maps to multiple provider models with priorities
 */

export interface IProviderMapping {
  modelConfigId: mongoose.Types.ObjectId;  // Reference to ModelConfig
  provider: string;                        // "openai", "anthropic", etc.
  modelId: string;                         // "gpt-4o", "claude-sonnet-4", etc.
  priority: number;                        // 1 = highest, lower number = try first
  qualityScore: number;                    // 0-100 quality rating
  isActive: boolean;                       // Can be toggled without deleting
}

export interface IAliaModel extends Document {
  // Model Identity
  aliasModelId: string;                    // "alia-v1", "alia-lite", etc.
  displayName: string;                     // "Alia V1", "Alia Lite"
  tier: string;                            // "lite", "v1", "v1-codea", etc.

  // Description
  description?: string;
  features?: string[];                     // ["Fast responses", "Code generation"]

  // Provider Mappings (ordered by priority)
  providerMappings: IProviderMapping[];

  // Pricing & Credits
  creditMultiplier: number;                // Cost multiplier (1.0 = base, 1.5 = 50% more)
  isFreeTier: boolean;                     // Available in free tier?

  // Capabilities (aggregated from provider models)
  aggregatedCapabilities: {
    vision: boolean;
    audio: boolean;
    codeExecution: boolean;
    webSearch: boolean;
    thinking: boolean;
  };

  // Status
  isActive: boolean;
  isDeprecated: boolean;
  isLegacy: boolean;
  deprecationDate?: Date;
  replacementModelId?: string;

  // Usage Stats
  totalRequests: number;
  totalTokens: number;
  averageLatencyMs: number;

  // Metadata
  notes?: string;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;

  // Methods
  getAvailableProviders(): Promise<IProviderMapping[]>;
  getNextProvider(skipProviders: Set<string>): Promise<IProviderMapping | null>;
}

const ProviderMappingSchema = new Schema({
  modelConfigId: {
    type: Schema.Types.ObjectId,
    ref: 'ModelConfig',
    required: true,
  },
  provider: {
    type: String,
    required: true,
  },
  modelId: {
    type: String,
    required: true,
  },
  priority: {
    type: Number,
    required: true,
    min: 1,
    max: 100,
  },
  qualityScore: {
    type: Number,
    required: true,
    min: 0,
    max: 100,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, { _id: false });

const AliaModelSchema = new Schema<IAliaModel>(
  {
    aliasModelId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
    },
    displayName: {
      type: String,
      required: true,
    },
    tier: {
      type: String,
      required: true,
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
    description: {
      type: String,
      maxlength: 1000,
    },
    features: {
      type: [String],
      default: [],
    },
    providerMappings: {
      type: [ProviderMappingSchema],
      default: [],
    },
    creditMultiplier: {
      type: Number,
      required: true,
      default: 1.0,
      min: 0.1,
      max: 10,
    },
    isFreeTier: {
      type: Boolean,
      default: true,
    },
    aggregatedCapabilities: {
      vision: { type: Boolean, default: false },
      audio: { type: Boolean, default: false },
      codeExecution: { type: Boolean, default: false },
      webSearch: { type: Boolean, default: false },
      thinking: { type: Boolean, default: false },
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
    isLegacy: {
      type: Boolean,
      default: false,
    },
    deprecationDate: {
      type: Date,
    },
    replacementModelId: {
      type: String,
    },
    totalRequests: {
      type: Number,
      default: 0,
    },
    totalTokens: {
      type: Number,
      default: 0,
    },
    averageLatencyMs: {
      type: Number,
      default: 0,
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

// Indexes
AliaModelSchema.index({ tier: 1, isActive: 1 });
AliaModelSchema.index({ isActive: 1, isDeprecated: 1 });

// Methods
AliaModelSchema.methods.getAvailableProviders = async function (): Promise<IProviderMapping[]> {
  // Return active provider mappings sorted by priority
  return this.providerMappings
    .filter((mapping: IProviderMapping) => mapping.isActive)
    .sort((a: IProviderMapping, b: IProviderMapping) => a.priority - b.priority);
};

AliaModelSchema.methods.getNextProvider = async function (
  skipProviders: Set<string> = new Set()
): Promise<IProviderMapping | null> {
  const available = await this.getAvailableProviders();

  // Find first provider not in skip list
  for (const mapping of available) {
    if (!skipProviders.has(mapping.provider)) {
      return mapping;
    }
  }

  return null;
};

export const AliaModel = (mongoose.models.AliaModel || mongoose.model<IAliaModel>('AliaModel', AliaModelSchema)) as mongoose.Model<IAliaModel>;
