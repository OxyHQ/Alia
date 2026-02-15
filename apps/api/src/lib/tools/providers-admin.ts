import { tool } from 'ai';
import { z } from 'zod';
import crypto from 'crypto';
import { ProviderKey } from '../../internal/providers/models/provider-key.js';
import { ModelConfig } from '../../internal/providers/models/model-config.js';
import { AliaModel } from '../../internal/providers/models/alia-model.js';
import { ApiUsage } from '../../internal/providers/models/api-usage.js';
import { log } from '../logger.js';

/**
 * Get the Mongoose model for a given entity name.
 */
function getModel(entity: string) {
  switch (entity) {
    case 'keys': return ProviderKey;
    case 'models': return ModelConfig;
    case 'aliaModels': return AliaModel;
    case 'usage': return ApiUsage;
    default: throw new Error(`Unknown entity: ${entity}`);
  }
}

/**
 * Strip sensitive fields (raw key, keyHash) from ProviderKey documents.
 */
function sanitize(entity: string, docs: any[]): any[] {
  if (entity === 'keys') {
    return docs.map(doc => {
      const { key, keyHash, ...safe } = doc;
      return safe;
    });
  }
  return docs;
}

/**
 * Aggregation / stats queries for different entities.
 */
async function getStats(entity: string, filter: Record<string, any> | undefined, days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  if (entity === 'usage') {
    const pipeline: any[] = [
      { $match: { timestamp: { $gte: since }, ...(filter || {}) } },
      {
        $group: {
          _id: { provider: '$provider', modelId: '$modelId' },
          totalTokens: { $sum: '$tokens' },
          totalRequests: { $sum: 1 },
        },
      },
      { $sort: { totalTokens: -1 } },
    ];
    const result = await ApiUsage.aggregate(pipeline);
    return { success: true, period: `${days} days`, data: result };
  }

  if (entity === 'keys') {
    const keys = await ProviderKey.find(filter || {})
      .select('name provider keyPrefix isActive isArchived currentPriority originalPriority totalRequests totalTokens successCount totalFailures consecutiveFailures lastUsedAt lastSuccessAt lastFailureAt lastFailureReason tier environment isPaid')
      .sort({ provider: 1, currentPriority: 1 })
      .lean();
    return { success: true, data: keys };
  }

  if (entity === 'aliaModels') {
    const models = await AliaModel.find(filter || {})
      .select('aliasModelId displayName tier isActive isLegacy totalRequests totalTokens averageLatencyMs providerMappings')
      .lean();
    return { success: true, data: models };
  }

  return { success: false, message: 'Stats not supported for this entity' };
}

/**
 * Admin tool for managing AI providers, keys, models, and Alia models.
 * Only available to admin users (gated by username check in chat.ts).
 */
export function createProvidersAdminTool() {
  return tool({
    description:
      'Admin tool for managing AI providers infrastructure. Supports CRUD operations on: keys (API keys for providers), models (provider model configs), aliaModels (virtual Alia model mappings), and usage (API usage stats). Use action "stats" for health overviews and aggregated usage data.',

    inputSchema: z.object({
      entity: z
        .enum(['keys', 'models', 'aliaModels', 'usage'])
        .describe('Which collection to operate on: keys (provider API keys), models (provider model configs), aliaModels (virtual Alia models), usage (API usage records)'),

      action: z
        .enum(['list', 'get', 'create', 'update', 'delete', 'stats'])
        .describe('Operation: list (query with filters), get (by id), create, update (by id), delete (by id), stats (aggregated overview)'),

      id: z
        .string()
        .optional()
        .describe('MongoDB document _id. Required for get, update, delete.'),

      filter: z
        .record(z.any())
        .optional()
        .describe('Query filter as key-value pairs for list action, e.g. {"provider":"openai","isActive":true}'),

      data: z
        .record(z.any())
        .optional()
        .describe('Document data for create, or fields to update for update action'),

      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Max documents to return for list (default 20)'),

      days: z
        .number()
        .optional()
        .default(7)
        .describe('Lookback period in days for stats queries (default 7)'),
    }),

    execute: async ({ entity, action, id, filter, data, limit, days }) => {
      try {
        const model = getModel(entity);

        switch (action) {
          case 'list': {
            const docs = await model.find(filter || {}).limit(limit).sort({ createdAt: -1 }).lean();
            return { success: true, count: docs.length, data: sanitize(entity, docs) };
          }

          case 'get': {
            if (!id) return { success: false, message: 'id is required for get action' };
            const doc = await model.findById(id).lean();
            if (!doc) return { success: false, message: 'Document not found' };
            return { success: true, data: sanitize(entity, [doc])[0] };
          }

          case 'create': {
            if (!data) return { success: false, message: 'data is required for create action' };

            // Special handling for provider keys: hash the raw key
            if (entity === 'keys' && data.key) {
              data.keyHash = crypto.createHash('sha256').update(data.key).digest('hex');
              data.keyPrefix = data.key.substring(0, Math.min(8, data.key.length)) + '...';
            }

            const doc = await model.create(data);
            return { success: true, data: sanitize(entity, [doc.toObject()])[0] };
          }

          case 'update': {
            if (!id) return { success: false, message: 'id is required for update action' };
            if (!data) return { success: false, message: 'data is required for update action' };

            // Prevent updating the raw key field directly — use key rotation instead
            if (entity === 'keys') {
              delete data.key;
              delete data.keyHash;
            }

            const doc = await model.findByIdAndUpdate(id, { $set: data }, { new: true }).lean();
            if (!doc) return { success: false, message: 'Document not found' };
            return { success: true, data: sanitize(entity, [doc])[0] };
          }

          case 'delete': {
            if (!id) return { success: false, message: 'id is required for delete action' };

            // Soft delete for provider keys to prevent accidental data loss
            if (entity === 'keys') {
              const doc = await ProviderKey.findByIdAndUpdate(
                id,
                {
                  $set: {
                    isActive: false,
                    isArchived: true,
                    archivedAt: new Date(),
                    archivedReason: 'Deleted via admin chat tool',
                  },
                },
                { new: true }
              ).lean();
              if (!doc) return { success: false, message: 'Key not found' };
              return { success: true, message: `Provider key "${doc.name}" archived (soft delete)` };
            }

            const doc = await model.findByIdAndDelete(id);
            if (!doc) return { success: false, message: 'Document not found' };
            return { success: true, message: 'Document deleted' };
          }

          case 'stats': {
            return await getStats(entity, filter, days);
          }

          default:
            return { success: false, message: `Unknown action: ${action}` };
        }
      } catch (error: any) {
        log.tools.error({ err: error }, 'Error');
        return { success: false, message: error.message };
      }
    },
  });
}
