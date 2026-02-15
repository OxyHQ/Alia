import { registerHook } from '../hook-runner.js';
import mongoose, { Schema, Model, Document } from 'mongoose';
import { log } from '../../logger.js';

interface IChatAnalyticsFields {
  oxyUserId: mongoose.Types.ObjectId;
  conversationId?: string;
  model: string;
  aliaModelId?: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  platform: string;
  skillId?: string;
  createdAt: Date;
}

type IChatAnalytics = IChatAnalyticsFields & Omit<Document, 'model'>;

const ChatAnalyticsSchema = new Schema<IChatAnalytics>({
  oxyUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  conversationId: String,
  model: { type: String, required: true },
  aliaModelId: String,
  provider: { type: String, required: true },
  promptTokens: { type: Number, default: 0 },
  completionTokens: { type: Number, default: 0 },
  totalTokens: { type: Number, default: 0 },
  latencyMs: { type: Number, default: 0 },
  platform: { type: String, default: 'app' },
  skillId: String,
}, { timestamps: true });

// Index for time-based analytics queries
ChatAnalyticsSchema.index({ oxyUserId: 1, createdAt: -1 });

export const ChatAnalytics: Model<IChatAnalytics> = mongoose.models.ChatAnalytics || mongoose.model<IChatAnalytics>('ChatAnalytics', ChatAnalyticsSchema);

registerHook({
  name: 'analytics',
  afterChat: async (ctx) => {
    if (!ctx.userId) return;
    try {
      await ChatAnalytics.create({
        oxyUserId: ctx.userId,
        conversationId: ctx.conversationId,
        model: ctx.modelUsed,
        aliaModelId: ctx.model,
        provider: ctx.metadata.provider || 'unknown',
        promptTokens: ctx.tokenUsage.promptTokens,
        completionTokens: ctx.tokenUsage.completionTokens,
        totalTokens: ctx.tokenUsage.totalTokens,
        latencyMs: ctx.latencyMs,
        platform: ctx.platform,
        skillId: ctx.skillId,
      });
    } catch (error) {
      log.chat.error({ err: error }, 'Error saving analytics');
    }
  },
});
