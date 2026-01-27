/**
 * Keys API Routes (Admin Only)
 * Handles provider API key management
 */

import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { authenticateService } from '../middleware/auth';
import { ProviderKey } from '../models/provider-key';
import { invalidateKeyCache } from '../lib/key-manager';

const router = express.Router();

// All routes require service authentication
router.use(authenticateService);

/**
 * GET /v1/keys
 * List all provider keys (returns hashed keys only, never actual keys)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { provider, environment, active } = req.query;

    // Build query
    const query: any = {};
    if (provider) query.provider = provider;
    if (environment) query.environment = environment;
    if (active !== undefined) query.isActive = active === 'true';

    // Get keys (exclude keyHash and encryptedKey for security)
    const keys = await ProviderKey.find(query)
      .select('-keyHash -encryptedKey')
      .sort({ provider: 1, priority: 1 });

    res.json({
      success: true,
      count: keys.length,
      data: keys,
    });
  } catch (error: any) {
    console.error('Error listing keys:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/keys/:keyId
 * Get specific key details (without actual key value)
 */
router.get('/:keyId', async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;

    const key = await ProviderKey.findById(keyId).select('-keyHash -encryptedKey');

    if (!key) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND',
      });
    }

    res.json({
      success: true,
      data: key,
    });
  } catch (error: any) {
    console.error('Error getting key:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/keys
 * Add new provider key
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, provider, key, environment, isPaid, tier, priority, rateLimit } = req.body;

    // Validate required fields
    if (!name || !provider || !key) {
      return res.status(400).json({
        success: false,
        error: 'name, provider, and key are required',
        code: 'INVALID_REQUEST',
      });
    }

    // Hash the key
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');

    // Check if key already exists
    const existing = await ProviderKey.findOne({ keyHash });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Key already exists',
        code: 'KEY_ALREADY_EXISTS',
      });
    }

    // Extract key prefix for display
    const keyPrefix = key.substring(0, Math.min(8, key.length)) + '...';

    // Create new key
    const newKey = await ProviderKey.create({
      name,
      provider,
      keyHash,
      keyPrefix,
      environment: environment || 'production',
      isPaid: isPaid || false,
      tier: tier || 'free',
      priority: priority || 10,
      rateLimit: rateLimit || {},
      isActive: true,
    });

    // Invalidate cache
    invalidateKeyCache(provider);

    res.status(201).json({
      success: true,
      data: {
        id: newKey._id,
        keyPrefix: newKey.keyPrefix,
        message: 'Key added successfully',
      },
    });
  } catch (error: any) {
    console.error('Error adding key:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * PATCH /v1/keys/:keyId
 * Update key configuration (cannot update the key itself, use rotate for that)
 */
router.patch('/:keyId', async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;
    const updates = req.body;

    // Don't allow updating keyHash or keyPrefix
    delete updates.keyHash;
    delete updates.keyPrefix;
    delete updates.encryptedKey;

    const key = await ProviderKey.findByIdAndUpdate(
      keyId,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-keyHash -encryptedKey');

    if (!key) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND',
      });
    }

    // Invalidate cache
    invalidateKeyCache(key.provider);

    res.json({
      success: true,
      data: key,
    });
  } catch (error: any) {
    console.error('Error updating key:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * DELETE /v1/keys/:keyId
 * Delete a provider key
 */
router.delete('/:keyId', async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;

    const key = await ProviderKey.findByIdAndDelete(keyId);

    if (!key) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND',
      });
    }

    // Invalidate cache
    invalidateKeyCache(key.provider);

    res.json({
      success: true,
      message: 'Key deleted successfully',
    });
  } catch (error: any) {
    console.error('Error deleting key:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/keys/:keyId/rotate
 * Rotate a provider key (replace with new key)
 */
router.post('/:keyId/rotate', async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;
    const { newKey } = req.body;

    if (!newKey) {
      return res.status(400).json({
        success: false,
        error: 'newKey is required',
        code: 'INVALID_REQUEST',
      });
    }

    // Find existing key
    const key = await ProviderKey.findById(keyId);
    if (!key) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND',
      });
    }

    // Hash the new key
    const newKeyHash = crypto.createHash('sha256').update(newKey).digest('hex');

    // Check if new key already exists
    const existing = await ProviderKey.findOne({ keyHash: newKeyHash });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'New key already exists in system',
        code: 'KEY_ALREADY_EXISTS',
      });
    }

    // Update key
    const newKeyPrefix = newKey.substring(0, Math.min(8, newKey.length)) + '...';
    key.keyHash = newKeyHash;
    key.keyPrefix = newKeyPrefix;
    key.rotatedAt = new Date();
    await key.save();

    // Invalidate cache
    invalidateKeyCache(key.provider);

    res.json({
      success: true,
      data: {
        keyPrefix: key.keyPrefix,
        rotatedAt: key.rotatedAt,
        message: 'Key rotated successfully',
      },
    });
  } catch (error: any) {
    console.error('Error rotating key:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/keys/:keyId/deactivate
 * Deactivate a key (soft delete)
 */
router.post('/:keyId/deactivate', async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;

    const key = await ProviderKey.findByIdAndUpdate(
      keyId,
      { $set: { isActive: false } },
      { new: true }
    ).select('-keyHash -encryptedKey');

    if (!key) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND',
      });
    }

    // Invalidate cache
    invalidateKeyCache(key.provider);

    res.json({
      success: true,
      data: key,
      message: 'Key deactivated successfully',
    });
  } catch (error: any) {
    console.error('Error deactivating key:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/keys/:keyId/activate
 * Activate a previously deactivated key
 */
router.post('/:keyId/activate', async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;

    const key = await ProviderKey.findByIdAndUpdate(
      keyId,
      { $set: { isActive: true } },
      { new: true }
    ).select('-keyHash -encryptedKey');

    if (!key) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND',
      });
    }

    // Invalidate cache
    invalidateKeyCache(key.provider);

    res.json({
      success: true,
      data: key,
      message: 'Key activated successfully',
    });
  } catch (error: any) {
    console.error('Error activating key:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
