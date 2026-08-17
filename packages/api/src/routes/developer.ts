import { Router, Request, Response } from 'express';
import {
  deleteUsageForApp,
  deleteUsageForKey,
  usageByDay,
  usageByEndpoint,
  usageSummary,
  type UsageScope,
} from '../db/telemetry/apiKeyUsageRepository.js';
import { getApiKeyUsageStats } from '../middleware/api-key-rate-limit';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import {
  countActiveApps,
  countKeysForApps,
  deleteKeysForApp,
  deleteOwnedApp,
  deleteOwnedKey,
  findOwnedApp,
  findOwnedKey,
  selectAppsForOwner,
  selectKeysForApp,
  toDeveloperApiKeyResponse,
  toDeveloperAppResponse,
  updateOwnedApp,
  updateOwnedKey,
} from '../db/developers/developerRepository.js';
import { refuseIssuance } from '../middleware/credential-deprecation.js';
import { log } from '../lib/logger.js';

const router = Router();

// Build the organization scope from req.workspace (set by resolveWorkspace middleware)
function orgFilter(req: Request): { organizationId: string | null } {
  return { organizationId: req.workspace?.id ?? null };
}


// ============================================
// DEVELOPER APPS ROUTES
// ============================================

// Get all apps for the authenticated user (scoped by X-Workspace-Id header)
router.get('/apps', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const apps = await selectAppsForOwner(getDb(), userId, orgFilter(req));
    res.json({ apps: apps.map(toDeveloperAppResponse) });
  } catch (error: unknown) {
    log.developer.error({ err: error }, 'Error fetching developer apps');
    res.status(500).json({ error: 'Failed to fetch apps' });
  }
});

// Get a single app by ID
router.get('/apps/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = req.params.id as string;

    const app = await findOwnedApp(getDb(), id, userId);

    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    res.json({ app: toDeveloperAppResponse(app) });
  } catch (error: unknown) {
    log.developer.error({ err: error }, 'Error fetching developer app');
    res.status(500).json({ error: 'Failed to fetch app' });
  }
});

/**
 * Registration of a new Alia developer application: CLOSED.
 *
 * ADR 0001 gives applications to Oxy, and every application this route created
 * existed to hold `alia_sk_*` keys for the generic inference surface — so
 * closing it is #139 workstream 11's "stop creating Alia-specific developer
 * applications for generic inference".
 *
 * The route keeps its shape so the response can carry the instruction; the
 * body schema is gone with the write it validated.
 */
router.post('/apps', (_req: Request, res: Response) => {
  refuseIssuance(res, 'developer_application');
});

// Update an app
const updateAppSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  websiteUrl: z.string().url().optional().or(z.literal('')),
  redirectUrls: z.array(z.string().url()).optional(),
  icon: z.string().optional(),
  isActive: z.boolean().optional(),
});

router.patch('/apps/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = req.params.id as string;

    const validatedData = updateAppSchema.parse(req.body);

    const app = await updateOwnedApp(getDb(), id, userId, validatedData);

    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    res.json({ app: toDeveloperAppResponse(app) });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.developer.error({ err: error }, 'Error updating developer app');
    res.status(500).json({ error: 'Failed to update app' });
  }
});

// Delete an app
router.delete('/apps/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = req.params.id as string;

    const app = await deleteOwnedApp(getDb(), id, userId);

    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    // Also delete all API keys associated with this app. `developer_api_keys`
    // cascades on `app_id`, so this is now redundant — kept because it is
    // idempotent and removing it would leave the route depending silently on a
    // schema property stated nowhere near it.
    await deleteKeysForApp(getDb(), id, userId);

    // Delete usage data
    await deleteUsageForApp(getDb(), String(id), userId);

    res.json({ message: 'App deleted successfully' });
  } catch (error: unknown) {
    log.developer.error({ err: error }, 'Error deleting developer app');
    res.status(500).json({ error: 'Failed to delete app' });
  }
});

// ============================================
// API KEYS ROUTES
// ============================================

// Get all API keys for a specific app
router.get('/apps/:appId/keys', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const appId = req.params.appId as string;

    // Verify the app belongs to the user
    const app = await findOwnedApp(getDb(), appId, userId);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    const keys = (await selectKeysForApp(getDb(), appId, userId)).map(toDeveloperApiKeyResponse);

    res.json({ keys });
  } catch (error: unknown) {
    log.developer.error({ err: error }, 'Error fetching API keys');
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

/**
 * Minting a new `alia_sk_*` credential: CLOSED. #139 workstream 11, "stop
 * issuing new `alia_sk_*` keys".
 *
 * It refuses BEFORE looking the app up, so the answer does not depend on the
 * database being reachable and cannot vary by app: there is no state in which
 * this route mints a key, which is the property the suite beside it asserts.
 * That also means a caller naming an app it does not own gets the migration
 * instruction rather than a 404 — no ownership is disclosed either way, because
 * the response is identical for every app id.
 */
router.post('/apps/:appId/keys', (_req: Request, res: Response) => {
  refuseIssuance(res, 'developer_api_key');
});

// Rate limit configuration schema
const rateLimitSchema = z.object({
  requestsPerMinute: z.number().int().min(1).nullable().optional(),
  requestsPerDay: z.number().int().min(1).nullable().optional(),
  tokensPerMinute: z.number().int().min(1).nullable().optional(),
  tokensPerDay: z.number().int().min(1).nullable().optional(),
});

// Update an API key (name, scopes, isActive, rateLimit)
const updateApiKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  scopes: z.array(z.enum([
    'chat:read',
    'chat:write',
    'models:read',
    'conversations:read',
    'conversations:write',
    'conversations:delete',
    'memory:read',
    'memory:write',
  ])).optional(),
  isActive: z.boolean().optional(),
  rateLimit: rateLimitSchema.optional(),
});

router.patch('/apps/:appId/keys/:keyId', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const appId = req.params.appId as string;
    const keyId = req.params.keyId as string;

    // Verify the app belongs to the user
    const app = await findOwnedApp(getDb(), appId, userId);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    const validatedData = updateApiKeySchema.parse(req.body);

    const updated = await updateOwnedKey(getDb(), keyId, appId, userId, validatedData);

    if (!updated) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ apiKey: toDeveloperApiKeyResponse(updated) });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.developer.error({ err: error }, 'Error updating API key');
    res.status(500).json({ error: 'Failed to update API key' });
  }
});

// Delete an API key
router.delete('/apps/:appId/keys/:keyId', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const appId = req.params.appId as string;
    const keyId = req.params.keyId as string;

    // Verify the app belongs to the user
    const app = await findOwnedApp(getDb(), appId, userId);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    const apiKey = await deleteOwnedKey(getDb(), keyId, appId, userId);

    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }

    // Delete usage data
    await deleteUsageForKey(getDb(), String(keyId), userId);

    res.json({ message: 'API key deleted successfully' });
  } catch (error: unknown) {
    log.developer.error({ err: error }, 'Error deleting API key');
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

// Get rate limit status for an API key (current usage vs limits)
router.get('/apps/:appId/keys/:keyId/rate-limits', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const appId = req.params.appId as string;
    const keyId = req.params.keyId as string;

    // Verify the app belongs to the user
    const app = await findOwnedApp(getDb(), appId, userId);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    // Get the API key with rate limits
    const apiKey = await findOwnedKey(getDb(), keyId, appId, userId);

    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }

    // Get current usage stats
    const usage = await getApiKeyUsageStats(keyId as string);

    /**
     * The four flattened columns. NULL means UNLIMITED, never zero — a zero
     * would read as "no requests permitted", which is the opposite — so the
     * `?? null` below preserves an explicit null rather than defaulting it away.
     * Only `requestsPerDay` has a non-null default, at 1000, exactly as the
     * sub-document had.
     */
    const rateLimit = {
      requestsPerMinute: apiKey.rateLimitRequestsPerMinute,
      requestsPerDay: apiKey.rateLimitRequestsPerDay,
      tokensPerMinute: apiKey.rateLimitTokensPerMinute,
      tokensPerDay: apiKey.rateLimitTokensPerDay,
    };

    res.json({
      keyName: apiKey.name,
      keyPrefix: apiKey.keyPrefix,
      limits: rateLimit,
      currentUsage: usage,
      status: {
        requestsPerMinute: rateLimit.requestsPerMinute !== null
          ? { current: usage.requestsLastMinute, limit: rateLimit.requestsPerMinute, remaining: Math.max(0, rateLimit.requestsPerMinute - usage.requestsLastMinute) }
          : { current: usage.requestsLastMinute, limit: null, remaining: null },
        requestsPerDay: rateLimit.requestsPerDay !== null
          ? { current: usage.requestsLastDay, limit: rateLimit.requestsPerDay, remaining: Math.max(0, rateLimit.requestsPerDay - usage.requestsLastDay) }
          : { current: usage.requestsLastDay, limit: null, remaining: null },
        tokensPerMinute: rateLimit.tokensPerMinute !== null
          ? { current: usage.tokensLastMinute, limit: rateLimit.tokensPerMinute, remaining: Math.max(0, rateLimit.tokensPerMinute - usage.tokensLastMinute) }
          : { current: usage.tokensLastMinute, limit: null, remaining: null },
        tokensPerDay: rateLimit.tokensPerDay !== null
          ? { current: usage.tokensLastDay, limit: rateLimit.tokensPerDay, remaining: Math.max(0, rateLimit.tokensPerDay - usage.tokensLastDay) }
          : { current: usage.tokensLastDay, limit: null, remaining: null },
      },
    });
  } catch (error: unknown) {
    log.developer.error({ err: error }, 'Error fetching rate limit status');
    res.status(500).json({ error: 'Failed to fetch rate limit status' });
  }
});

// Update rate limits for an API key
router.patch('/apps/:appId/keys/:keyId/rate-limits', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const appId = req.params.appId as string;
    const keyId = req.params.keyId as string;

    // Verify the app belongs to the user
    const app = await findOwnedApp(getDb(), appId, userId);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    const validatedData = rateLimitSchema.parse(req.body);

    // Build update object for only provided fields. The `rateLimit`
    // sub-document is four columns now; an ABSENT field still means "leave it
    // alone", and NULL still means unlimited rather than zero.
    const updateFields: Record<string, number | null> = {};
    if (validatedData.requestsPerMinute !== undefined) {
      updateFields.rateLimitRequestsPerMinute = validatedData.requestsPerMinute;
    }
    if (validatedData.requestsPerDay !== undefined) {
      updateFields.rateLimitRequestsPerDay = validatedData.requestsPerDay;
    }
    if (validatedData.tokensPerMinute !== undefined) {
      updateFields.rateLimitTokensPerMinute = validatedData.tokensPerMinute;
    }
    if (validatedData.tokensPerDay !== undefined) {
      updateFields.rateLimitTokensPerDay = validatedData.tokensPerDay;
    }

    const apiKey = await updateOwnedKey(getDb(), keyId, appId, userId, updateFields);

    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({
      message: 'Rate limits updated successfully',
      rateLimit: {
        requestsPerMinute: apiKey.rateLimitRequestsPerMinute,
        requestsPerDay: apiKey.rateLimitRequestsPerDay,
        tokensPerMinute: apiKey.rateLimitTokensPerMinute,
        tokensPerDay: apiKey.rateLimitTokensPerDay,
      },
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.developer.error({ err: error }, 'Error updating rate limits');
    res.status(500).json({ error: 'Failed to update rate limits' });
  }
});

// ============================================
// USAGE STATISTICS ROUTES
// ============================================

// Get usage statistics for an app
router.get('/apps/:appId/usage', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const appId = req.params.appId as string;
    const { period = '7d' } = req.query;

    // Verify the app belongs to the user
    const app = await findOwnedApp(getDb(), appId, userId);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    // Calculate date range
    const now = new Date();
    const startDate = new Date();

    switch (period) {
      case '24h':
        startDate.setHours(now.getHours() - 24);
        break;
      case '7d':
        startDate.setDate(now.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(now.getDate() - 30);
        break;
      case '90d':
        startDate.setDate(now.getDate() - 90);
        break;
      default:
        startDate.setDate(now.getDate() - 7);
    }

    // Get usage statistics
    const scope: UsageScope = { kind: 'apps', appIds: [app.id] };
    const usage = await usageSummary(getDb(), scope, startDate);

    // Get usage by day
    const byDay = await usageByDay(getDb(), scope, startDate);

    // Get usage by endpoint
    const byEndpoint = await usageByEndpoint(getDb(), scope, startDate);

    res.json({
      summary: usage,
      byDay,
      byEndpoint,
    });
  } catch (error: unknown) {
    log.developer.error({ err: error }, 'Error fetching usage statistics');
    res.status(500).json({ error: 'Failed to fetch usage statistics' });
  }
});

// Get usage statistics for a specific API key
router.get('/apps/:appId/keys/:keyId/usage', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const appId = req.params.appId as string;
    const keyId = req.params.keyId as string;
    const { period = '7d' } = req.query;

    // Verify the app belongs to the user
    const app = await findOwnedApp(getDb(), appId, userId);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    // Verify the API key belongs to the app
    const apiKey = await findOwnedKey(getDb(), keyId, appId, userId);
    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }

    // Calculate date range
    const now = new Date();
    const startDate = new Date();

    switch (period) {
      case '24h':
        startDate.setHours(now.getHours() - 24);
        break;
      case '7d':
        startDate.setDate(now.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(now.getDate() - 30);
        break;
      case '90d':
        startDate.setDate(now.getDate() - 90);
        break;
      default:
        startDate.setDate(now.getDate() - 7);
    }

    // Get usage statistics for this specific key
    const scope: UsageScope = { kind: 'key', apiKeyId: apiKey.id };
    const usage = await usageSummary(getDb(), scope, startDate);

    // Get usage by day
    const byDay = await usageByDay(getDb(), scope, startDate);

    res.json({
      summary: usage,
      byDay,
    });
  } catch (error: unknown) {
    log.developer.error({ err: error }, 'Error fetching API key usage statistics');
    res.status(500).json({ error: 'Failed to fetch usage statistics' });
  }
});

// Get global usage statistics across all apps (scoped by X-Workspace-Id header)
router.get('/usage', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { period = '7d' } = req.query;

    const appIds = (await selectAppsForOwner(getDb(), userId, orgFilter(req))).map((a) => a.id);

    // Calculate date range
    const now = new Date();
    const startDate = new Date();

    switch (period) {
      case '24h':
        startDate.setHours(now.getHours() - 24);
        break;
      case '7d':
        startDate.setDate(now.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(now.getDate() - 30);
        break;
      case '90d':
        startDate.setDate(now.getDate() - 90);
        break;
      default:
        startDate.setDate(now.getDate() - 7);
    }

    const scope: UsageScope = { kind: 'apps', appIds: appIds.map(String) };

    // Get aggregated usage statistics
    const usage = await usageSummary(getDb(), scope, startDate);

    // Get usage by day
    const byDay = await usageByDay(getDb(), scope, startDate);

    // Get usage by endpoint
    const byEndpoint = await usageByEndpoint(getDb(), scope, startDate);

    res.json({
      summary: usage,
      byDay,
      byEndpoint,
    });
  } catch (error: unknown) {
    log.developer.error({ err: error }, 'Error fetching global usage statistics');
    res.status(500).json({ error: 'Failed to fetch usage statistics' });
  }
});

// Get overall developer statistics (scoped by X-Workspace-Id header)
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const appIds = (await selectAppsForOwner(getDb(), userId, orgFilter(req))).map((a) => a.id);

    const db = getDb();
    const [activeApps, totalKeys, activeKeys] = await Promise.all([
      countActiveApps(db, appIds),
      countKeysForApps(db, appIds, userId),
      countKeysForApps(db, appIds, userId, { isActive: true }),
    ]);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const usage = await usageSummary(
      getDb(),
      { kind: 'apps', appIds: appIds.map(String) },
      thirtyDaysAgo,
    );

    res.json({
      totalApps: appIds.length,
      activeApps,
      totalKeys,
      activeKeys,
      last30Days: {
        totalRequests: usage.totalRequests,
        totalTokens: usage.totalTokens,
        totalCredits: usage.totalCredits,
      },
    });
  } catch (error: unknown) {
    log.developer.error({ err: error }, 'Error fetching developer stats');
    res.status(500).json({ error: 'Failed to fetch developer stats' });
  }
});

export default router;
