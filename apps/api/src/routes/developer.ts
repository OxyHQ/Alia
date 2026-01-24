import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth';
import DeveloperApp from '../models/developer-app';
import DeveloperApiKey from '../models/developer-api-key';
import ApiKeyUsage from '../models/api-key-usage';
import { z } from 'zod';

const router = Router();

// All routes require authentication
router.use(authenticateToken);

// ============================================
// DEVELOPER APPS ROUTES
// ============================================

// Get all apps for the authenticated user
router.get('/apps', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const apps = await DeveloperApp.find({ oxyUserId: userId }).sort({ createdAt: -1 });

    res.json({ apps });
  } catch (error) {
    console.error('Error fetching developer apps:', error);
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
    console.error('Error fetching developer app:', error);
    res.status(500).json({ error: 'Failed to fetch app' });
  }
});

// Create a new app
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
      ...validatedData,
    });

    await app.save();

    res.status(201).json({ app });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    console.error('Error creating developer app:', error);
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
      { new: true }
    );

    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    res.json({ app });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    console.error('Error updating developer app:', error);
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
    console.error('Error deleting developer app:', error);
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
    console.error('Error fetching API keys:', error);
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
    console.error('Error creating API key:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// Update an API key (name, scopes, isActive)
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
      { new: true }
    ).select('-keyHash');

    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ apiKey });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    console.error('Error updating API key:', error);
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
    console.error('Error deleting API key:', error);
    res.status(500).json({ error: 'Failed to delete API key' });
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
    console.error('Error fetching usage statistics:', error);
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
    console.error('Error fetching API key usage statistics:', error);
    res.status(500).json({ error: 'Failed to fetch usage statistics' });
  }
});

// Get overall developer statistics
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const totalApps = await DeveloperApp.countDocuments({ oxyUserId: userId });
    const activeApps = await DeveloperApp.countDocuments({ oxyUserId: userId, isActive: true });
    const totalKeys = await DeveloperApiKey.countDocuments({ oxyUserId: userId });
    const activeKeys = await DeveloperApiKey.countDocuments({ oxyUserId: userId, isActive: true });

    // Get total usage across all apps (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const usage = await ApiKeyUsage.aggregate([
      {
        $match: {
          oxyUserId: new mongoose.Types.ObjectId(userId),
          timestamp: { $gte: thirtyDaysAgo },
        },
      },
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
      totalApps,
      activeApps,
      totalKeys,
      activeKeys,
      last30Days: usage[0] || {
        totalRequests: 0,
        totalTokens: 0,
        totalCredits: 0,
      },
    });
  } catch (error) {
    console.error('Error fetching developer stats:', error);
    res.status(500).json({ error: 'Failed to fetch developer stats' });
  }
});

export default router;
