import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IProcessedWebhook extends Document {
  messageId: string;
  channel: string;
  processedAt: Date;
}

const ProcessedWebhookSchema = new Schema<IProcessedWebhook>({
  messageId: { type: String, required: true },
  channel: { type: String, required: true },
  processedAt: { type: Date, default: Date.now },
});

// Compound unique index: same message can't be processed twice per channel
ProcessedWebhookSchema.index({ messageId: 1, channel: 1 }, { unique: true });

// TTL: auto-delete after 24 hours (webhooks won't retry after that)
ProcessedWebhookSchema.index({ processedAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export const ProcessedWebhook: Model<IProcessedWebhook> =
  mongoose.models.ProcessedWebhook || mongoose.model<IProcessedWebhook>('ProcessedWebhook', ProcessedWebhookSchema);

/**
 * Check if a webhook message has already been processed.
 * If not, marks it as processed (atomic insert-if-not-exists).
 * Returns true if the message is new (should be processed).
 * Returns false if it's a duplicate (should be skipped).
 * Never throws — returns true on error (fail-open to not drop messages).
 */
export async function markWebhookProcessed(messageId: string, channel: string): Promise<boolean> {
  try {
    await ProcessedWebhook.create({ messageId, channel });
    return true; // New message, proceed with processing
  } catch (error: any) {
    if (error.code === 11000) {
      // Duplicate key error — message already processed
      return false;
    }
    // Unexpected error — fail open (process the message to avoid dropping it)
    console.error('[WebhookIdempotency] Error checking message:', error);
    return true;
  }
}
