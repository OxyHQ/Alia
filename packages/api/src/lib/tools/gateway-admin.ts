import { tool } from 'ai';
import { z } from 'zod';
import crypto from 'crypto';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';

const GATEWAY_API_URL = process.env.GATEWAY_API_URL;
const SERVICE_SECRET = process.env.SERVICE_SECRET;

/**
 * Build service-to-service auth headers. The HMAC binds the method, full path,
 * and a hash of the serialized body so a captured signature can't be replayed
 * against a different endpoint. MUST match `buildServiceSigningString` in
 * alia-gateway's auth middleware.
 */
function generateAuthHeaders(method: string, path: string, body: string = ''): Record<string, string> {
  if (!SERVICE_SECRET) throw new Error('SERVICE_SECRET is not configured');
  const timestamp = Date.now().toString();
  const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
  const payload = [timestamp, 'alia-api', method.toUpperCase(), path, bodyHash].join('\n');
  const signature = crypto.createHmac('sha256', SERVICE_SECRET).update(payload).digest('hex');
  return {
    'X-Service-Name': 'alia-api',
    'X-Timestamp': timestamp,
    'X-Signature': signature,
    'Content-Type': 'application/json',
  };
}

async function proxyRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const serializedBody = body !== undefined ? JSON.stringify(body) : undefined;
  const res = await fetch(`${GATEWAY_API_URL}${path}`, {
    method,
    headers: generateAuthHeaders(method, path, serializedBody ?? ''),
    body: serializedBody,
  });
  return res.json();
}

// Map entity names to admin API paths
const ENTITY_PATHS: Record<string, string> = {
  keys: '/gateway/v1/keys',
  models: '/gateway/v1/models',
  aliaModels: '/gateway/v1/alia-models',
  usage: '/gateway/v1/usage',
};

/**
 * Admin tool for managing AI providers, keys, models, and Alia models.
 * Routes all operations through the alia-gateway service.
 */
export function createGatewayAdminTool() {
  return tool({
    description:
      'Admin tool for managing AI providers infrastructure. Supports CRUD operations on: keys (API keys for providers), models (provider model configs), aliaModels (virtual Alia model mappings), and usage (API usage stats). Use action "stats" for health overviews and aggregated usage data.',

    inputSchema: z.object({
      entity: z
        .enum(['keys', 'models', 'aliaModels', 'usage'])
        .describe('Which collection to operate on'),

      action: z
        .enum(['list', 'get', 'create', 'update', 'delete', 'stats'])
        .describe('Operation to perform'),

      id: z.string().optional().describe('Document _id for get/update/delete'),
      filter: z.record(z.any()).optional().describe('Query filter for list'),
      data: z.record(z.any()).optional().describe('Document data for create/update'),
      limit: z.number().optional().default(20).describe('Max documents for list'),
      days: z.number().optional().default(7).describe('Lookback for stats'),
    }),

    execute: async ({ entity, action, id, filter, data, limit, days }) => {
      if (!GATEWAY_API_URL || !SERVICE_SECRET) {
        return {
          success: false,
          message: 'Gateway API not configured (requires SERVICE_SECRET and GATEWAY_API_URL)',
        };
      }
      try {
        const basePath = ENTITY_PATHS[entity];
        if (!basePath) return { success: false, message: `Unknown entity: ${entity}` };

        switch (action) {
          case 'list': {
            const params = new URLSearchParams();
            if (limit) params.set('limit', String(limit));
            if (filter) {
              for (const [k, v] of Object.entries(filter)) params.set(k, String(v));
            }
            return await proxyRequest('GET', `${basePath}?${params}`);
          }

          case 'get': {
            if (!id) return { success: false, message: 'id is required' };
            return await proxyRequest('GET', `${basePath}/${id}`);
          }

          case 'create': {
            if (!data) return { success: false, message: 'data is required' };
            return await proxyRequest('POST', basePath, data);
          }

          case 'update': {
            if (!id) return { success: false, message: 'id is required' };
            if (!data) return { success: false, message: 'data is required' };
            return await proxyRequest('PATCH', `${basePath}/${id}`, data);
          }

          case 'delete': {
            if (!id) return { success: false, message: 'id is required' };
            return await proxyRequest('DELETE', `${basePath}/${id}`);
          }

          case 'stats': {
            const params = new URLSearchParams();
            if (days) params.set('days', String(days));
            if (filter) {
              for (const [k, v] of Object.entries(filter)) params.set(k, String(v));
            }
            return await proxyRequest('GET', `${basePath}/stats?${params}`);
          }

          default:
            return { success: false, message: `Unknown action: ${action}` };
        }
      } catch (error: unknown) {
        log.tools.error({ err: error }, 'Admin tool error');
        return { success: false, message: getErrorMessage(error) };
      }
    },
  });
}
