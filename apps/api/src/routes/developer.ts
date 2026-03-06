import { Router, Request, Response } from 'express';
import DeveloperApp from '../models/developer-app';
import DeveloperApiKey from '../models/developer-api-key';
import ApiKeyUsage from '../models/api-key-usage';
import { getApiKeyUsageStats } from '../middleware/api-key-rate-limit';
import { z } from 'zod';
import { log } from '../lib/logger.js';

const router = Router();

// Build Mongoose filter from req.workspace (set by resolveWorkspace middleware)
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
    const apps = await DeveloperApp.find({ oxyUserId: userId, ...orgFilter(req) }).sort({ createdAt: -1 });
    res.json({ apps });
  } catch (error) {
    log.developer.error({ err: error }, 'Error fetching developer apps');
    res.status(500).json({ error: 'Failed to fetch apps' });
  }
});

// Get a single app by ID
router.get('/apps/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const app = await DeveloperApp.findOne({ _id: id, oxyUserId: userId });

    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    res.json({ app });
  } catch (error) {
    log.developer.error({ err: error }, 'Error fetching developer app');
    res.status(500).json({ error: 'Failed to fetch app' });
  }
});

// Create a new app (scoped by X-Workspace-Id header)
const createAppSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  websiteUrl: z.string().url().optional().or(z.literal('')),
  redirectUrls: z.array(z.string().url()).optional(),
  icon: z.string().optional(),
});

router.post('/apps', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const validatedData = createAppSchema.parse(req.body);

    const app = new DeveloperApp({
      oxyUserId: userId,
      organizationId: req.workspace?.id ?? null,
      ...validatedData,
    });

    await app.save();
    res.status(201).json({ app });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.developer.error({ err: error }, 'Error creating developer app');
    res.status(500).json({ error: 'Failed to create app' });
  }
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
    const { id } = req.params;

    const validatedData = updateAppSchema.parse(req.body);

    const app = await DeveloperApp.findOneAndUpdate(
      { _id: id, oxyUserId: userId },
      { $set: validatedData },
      { returnDocument: 'after' }
    );

    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    res.json({ app });
  } catch (error) {
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
    const { id } = req.params;

    const app = await DeveloperApp.findOneAndDelete({ _id: id, oxyUserId: userId });

    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    // Also delete all API keys associated with this app
    await DeveloperApiKey.deleteMany({ appId: id, oxyUserId: userId });

    // Delete usage data
    await ApiKeyUsage.deleteMany({ appId: id, oxyUserId: userId });

    res.json({ message: 'App deleted successfully' });
  } catch (error) {
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
    const { appId } = req.params;

    // Verify the app belongs to the user
    const app = await DeveloperApp.findOne({ _id: appId, oxyUserId: userId });
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    const keys = await DeveloperApiKey.find({ appId, oxyUserId: userId })
      .select('-keyHash') // Don't send the hash
      .sort({ createdAt: -1 });

    res.json({ keys });
  } catch (error) {
    log.developer.error({ err: error }, 'Error fetching API keys');
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

// Create a new API key
const createApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum([
    'chat:read',
    'chat:write',
    'models:read',
    'conversations:read',
    'conversations:write',
    'conversations:delete',
    'memory:read',
    'memory:write',
  ])).default(['chat:read', 'chat:write']),
  expiresAt: z.string().datetime().optional(),
});

router.post('/apps/:appId/keys', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { appId } = req.params;

    // Verify the app belongs to the user
    const app = await DeveloperApp.findOne({ _id: appId, oxyUserId: userId });
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    const validatedData = createApiKeySchema.parse(req.body);

    // Generate a new API key
    const plainKey = (DeveloperApiKey as any).generateKey();
    const keyHash = (DeveloperApiKey as any).hashKey(plainKey);
    const keyPrefix = plainKey.substring(0, 16); // "alia_sk_12345678"

    const apiKey = new DeveloperApiKey({
      oxyUserId: userId,
      appId,
      name: validatedData.name,
      keyHash,
      keyPrefix,
      scopes: validatedData.scopes,
      expiresAt: validatedData.expiresAt ? new Date(validatedData.expiresAt) : null,
    });

    await apiKey.save();

    // Return the plain key only this one time
    const keyResponse = {
      ...apiKey.toObject(),
      key: plainKey, // Only returned on creation
    };
    delete keyResponse.keyHash;

    res.status(201).json({
      apiKey: keyResponse,
      warning: 'This is the only time you will see this key. Please save it securely.',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.developer.error({ err: error }, 'Error creating API key');
    res.status(500).json({ error: 'Failed to create API key' });
  }
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
    const { appId, keyId } = req.params;

    // Verify the app belongs to the user
    const app = await DeveloperApp.findOne({ _id: appId, oxyUserId: userId });
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    const validatedData = updateApiKeySchema.parse(req.body);

    const apiKey = await DeveloperApiKey.findOneAndUpdate(
      { _id: keyId, appId, oxyUserId: userId },
      { $set: validatedData },
      { returnDocument: 'after' }
    ).select('-keyHash');

    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ apiKey });
  } catch (error) {
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
    const { appId, keyId } = req.params;

    // Verify the app belongs to the user
    const app = await DeveloperApp.findOne({ _id: appId, oxyUserId: userId });
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    const apiKey = await DeveloperApiKey.findOneAndDelete({ _id: keyId, appId, oxyUserId: userId });

    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }

    // Delete usage data
    await ApiKeyUsage.deleteMany({ apiKeyId: keyId, oxyUserId: userId });

    res.json({ message: 'API key deleted successfully' });
  } catch (error) {
    log.developer.error({ err: error }, 'Error deleting API key');
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

// Get rate limit status for an API key (current usage vs limits)
router.get('/apps/:appId/keys/:keyId/rate-limits', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { appId, keyId } = req.params;

    // Verify the app belongs to the user
    const app = await DeveloperApp.findOne({ _id: appId, oxyUserId: userId });
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    // Get the API key with rate limits
    const apiKey = await DeveloperApiKey.findOne({ _id: keyId, appId, oxyUserId: userId })
      .select('rateLimit name keyPrefix');

    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }

    // Get current usage stats
    const usage = await getApiKeyUsageStats(keyId as string);

    const rateLimit = apiKey.rateLimit || {
      requestsPerMinute: null,
      requestsPerDay: 1000,
      tokensPerMinute: null,
      tokensPerDay: null,
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
  } catch (error) {
    log.developer.error({ err: error }, 'Error fetching rate limit status');
    res.status(500).json({ error: 'Failed to fetch rate limit status' });
  }
});

// Update rate limits for an API key
router.patch('/apps/:appId/keys/:keyId/rate-limits', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { appId, keyId } = req.params;

    // Verify the app belongs to the user
    const app = await DeveloperApp.findOne({ _id: appId, oxyUserId: userId });
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    const validatedData = rateLimitSchema.parse(req.body);

    // Build update object for only provided fields
    const updateFields: Record<string, number | null> = {};
    if (validatedData.requestsPerMinute !== undefined) {
      updateFields['rateLimit.requestsPerMinute'] = validatedData.requestsPerMinute;
    }
    if (validatedData.requestsPerDay !== undefined) {
      updateFields['rateLimit.requestsPerDay'] = validatedData.requestsPerDay;
    }
    if (validatedData.tokensPerMinute !== undefined) {
      updateFields['rateLimit.tokensPerMinute'] = validatedData.tokensPerMinute;
    }
    if (validatedData.tokensPerDay !== undefined) {
      updateFields['rateLimit.tokensPerDay'] = validatedData.tokensPerDay;
    }

    const apiKey = await DeveloperApiKey.findOneAndUpdate(
      { _id: keyId, appId, oxyUserId: userId },
      { $set: updateFields },
      { returnDocument: 'after' }
    ).select('-keyHash');

    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({
      message: 'Rate limits updated successfully',
      rateLimit: apiKey.rateLimit,
    });
  } catch (error) {
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
    const { appId } = req.params;
    const { period = '7d' } = req.query;

    // Verify the app belongs to the user
    const app = await DeveloperApp.findOne({ _id: appId, oxyUserId: userId });
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    // Calculate date range
    const now = new Date();
    let startDate = new Date();

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
    const usage = await ApiKeyUsage.aggregate([
      {
        $match: {
          appId: app._id,
          timestamp: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          totalTokens: { $sum: '$tokensUsed' },
          totalCredits: { $sum: '$creditsUsed' },
          avgResponseTime: { $avg: '$responseTime' },
          successfulRequests: {
            $sum: {
              $cond: [{ $lt: ['$statusCode', 400] }, 1, 0],
            },
          },
          errorRequests: {
            $sum: {
              $cond: [{ $gte: ['$statusCode', 400] }, 1, 0],
            },
          },
        },
      },
    ]);

    // Get usage by day
    const usageByDay = await ApiKeyUsage.aggregate([
      {
        $match: {
          appId: app._id,
          timestamp: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$timestamp' },
          },
          requests: { $sum: 1 },
          tokens: { $sum: '$tokensUsed' },
          credits: { $sum: '$creditsUsed' },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ]);

    // Get usage by endpoint
    const usageByEndpoint = await ApiKeyUsage.aggregate([
      {
        $match: {
          appId: app._id,
          timestamp: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: '$endpoint',
          requests: { $sum: 1 },
          tokens: { $sum: '$tokensUsed' },
        },
      },
      {
        $sort: { requests: -1 },
      },
      {
        $limit: 10,
      },
    ]);

    res.json({
      summary: usage[0] || {
        totalRequests: 0,
        totalTokens: 0,
        totalCredits: 0,
        avgResponseTime: 0,
        successfulRequests: 0,
        errorRequests: 0,
      },
      byDay: usageByDay,
      byEndpoint: usageByEndpoint,
    });
  } catch (error) {
    log.developer.error({ err: error }, 'Error fetching usage statistics');
    res.status(500).json({ error: 'Failed to fetch usage statistics' });
  }
});

// Get usage statistics for a specific API key
router.get('/apps/:appId/keys/:keyId/usage', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { appId, keyId } = req.params;
    const { period = '7d' } = req.query;

    // Verify the app belongs to the user
    const app = await DeveloperApp.findOne({ _id: appId, oxyUserId: userId });
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    // Verify the API key belongs to the app
    const apiKey = await DeveloperApiKey.findOne({ _id: keyId, appId, oxyUserId: userId });
    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }

    // Calculate date range
    const now = new Date();
    let startDate = new Date();

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
    const usage = await ApiKeyUsage.aggregate([
      {
        $match: {
          apiKeyId: apiKey._id,
          timestamp: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          totalTokens: { $sum: '$tokensUsed' },
          totalCredits: { $sum: '$creditsUsed' },
          avgResponseTime: { $avg: '$responseTime' },
          successfulRequests: {
            $sum: {
              $cond: [{ $lt: ['$statusCode', 400] }, 1, 0],
            },
          },
          errorRequests: {
            $sum: {
              $cond: [{ $gte: ['$statusCode', 400] }, 1, 0],
            },
          },
        },
      },
    ]);

    // Get usage by day
    const usageByDay = await ApiKeyUsage.aggregate([
      {
        $match: {
          apiKeyId: apiKey._id,
          timestamp: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$timestamp' },
          },
          requests: { $sum: 1 },
          tokens: { $sum: '$tokensUsed' },
          credits: { $sum: '$creditsUsed' },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ]);

    res.json({
      summary: usage[0] || {
        totalRequests: 0,
        totalTokens: 0,
        totalCredits: 0,
        avgResponseTime: 0,
        successfulRequests: 0,
        errorRequests: 0,
      },
      byDay: usageByDay,
    });
  } catch (error) {
    log.developer.error({ err: error }, 'Error fetching API key usage statistics');
    res.status(500).json({ error: 'Failed to fetch usage statistics' });
  }
});

// Get global usage statistics across all apps (scoped by X-Workspace-Id header)
router.get('/usage', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { period = '7d' } = req.query;

    const appIds = await DeveloperApp.find({ oxyUserId: userId, ...orgFilter(req) }).distinct('_id');

    // Calculate date range
    const now = new Date();
    let startDate = new Date();

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

    const timeFilter = { appId: { $in: appIds }, timestamp: { $gte: startDate } };

    // Get aggregated usage statistics
    const usage = await ApiKeyUsage.aggregate([
      { $match: timeFilter },
      {
        $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          totalTokens: { $sum: '$tokensUsed' },
          totalCredits: { $sum: '$creditsUsed' },
          avgResponseTime: { $avg: '$responseTime' },
          successfulRequests: {
            $sum: {
              $cond: [{ $lt: ['$statusCode', 400] }, 1, 0],
            },
          },
          errorRequests: {
            $sum: {
              $cond: [{ $gte: ['$statusCode', 400] }, 1, 0],
            },
          },
        },
      },
    ]);

    // Get usage by day
    const usageByDay = await ApiKeyUsage.aggregate([
      { $match: timeFilter },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$timestamp' },
          },
          requests: { $sum: 1 },
          tokens: { $sum: '$tokensUsed' },
          credits: { $sum: '$creditsUsed' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Get usage by endpoint
    const usageByEndpoint = await ApiKeyUsage.aggregate([
      { $match: timeFilter },
      {
        $group: {
          _id: '$endpoint',
          requests: { $sum: 1 },
          tokens: { $sum: '$tokensUsed' },
        },
      },
      { $sort: { requests: -1 } },
      { $limit: 10 },
    ]);

    res.json({
      summary: usage[0] || {
        totalRequests: 0,
        totalTokens: 0,
        totalCredits: 0,
        avgResponseTime: 0,
        successfulRequests: 0,
        errorRequests: 0,
      },
      byDay: usageByDay,
      byEndpoint: usageByEndpoint,
    });
  } catch (error) {
    log.developer.error({ err: error }, 'Error fetching global usage statistics');
    res.status(500).json({ error: 'Failed to fetch usage statistics' });
  }
});

// Get overall developer statistics (scoped by X-Workspace-Id header)
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const appIds = await DeveloperApp.find({ oxyUserId: userId, ...orgFilter(req) }).distinct('_id');

    const [activeApps, totalKeys, activeKeys] = await Promise.all([
      DeveloperApp.countDocuments({ _id: { $in: appIds }, isActive: true }),
      DeveloperApiKey.countDocuments({ appId: { $in: appIds }, oxyUserId: userId }),
      DeveloperApiKey.countDocuments({ appId: { $in: appIds }, oxyUserId: userId, isActive: true }),
    ]);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const usage = await ApiKeyUsage.aggregate([
      { $match: { appId: { $in: appIds }, timestamp: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          totalTokens: { $sum: '$tokensUsed' },
          totalCredits: { $sum: '$creditsUsed' },
        },
      },
    ]);

    res.json({
      totalApps: appIds.length,
      activeApps,
      totalKeys,
      activeKeys,
      last30Days: usage[0] || { totalRequests: 0, totalTokens: 0, totalCredits: 0 },
    });
  } catch (error) {
    log.developer.error({ err: error }, 'Error fetching developer stats');
    res.status(500).json({ error: 'Failed to fetch developer stats' });
  }
});

export default router;
