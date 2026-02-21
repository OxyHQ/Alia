/**
 * Keys API Routes (Admin Only)
 * Handles provider API key management
 */

import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { ProviderKey } from '../models/provider-key.js';
import { invalidateKeyCache } from '../lib/key-manager.js';
import { clearHealthCache } from '../lib/provider-health.js';
import { broadcastKeysUpdate } from '../lib/broadcast-helpers.js';
import { log } from '../lib/logger.js';
import { PROVIDER_NAMES } from '../lib/provider-names.js';

const router = express.Router();

// Note: Service authentication is applied at mount point in index.ts

// Valid provider names (derived from shared constant)
const VALID_PROVIDERS: string[] = [...PROVIDER_NAMES];

// Sanitize string input: must be a non-empty string within length limits
function sanitizeString(value: unknown, maxLength = 200): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

// Sanitize query param: reject objects (NoSQL injection prevention)
function sanitizeQueryParam(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  return value;
}

/**
 * POST /v1/keys/reload
 * Invalidate all in-memory caches and reload provider configuration
 */
router.post('/reload', async (req: Request, res: Response) => {
  try {
    // Clear all in-memory caches
    invalidateKeyCache();
    clearHealthCache();

    // Reset all key cooldowns and failure counters
    const cooldownResult = await ProviderKey.updateMany(
      { $or: [{ cooldownUntil: { $ne: null } }, { consecutiveFailures: { $gt: 0 } }] },
      { $set: { cooldownUntil: null, consecutiveFailures: 0 } }
    );
    const cooldownsReset = cooldownResult.modifiedCount;

    // Compute config hash for tracking
    const keyCount = await ProviderKey.countDocuments({ isArchived: false, isActive: true });
    const configHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ keyCount, reloadedAt: Date.now() }))
      .digest('hex')
      .substring(0, 12);

    log.keys.info({ configHash, keyCount, cooldownsReset }, 'Configuration reloaded');

    res.json({
      success: true,
      message: 'Configuration reloaded successfully',
      configHash,
      keyCount,
      cooldownsReset,
      reloadedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    log.keys.error({ err: error }, 'Error');
    res.status(500).json({ success: false, error: 'Failed to reload configuration' });
  }
});

/**
 * GET /v1/keys
 * List all provider keys (returns hashed keys only, never actual keys)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const provider = sanitizeQueryParam(req.query.provider);
    const environment = sanitizeQueryParam(req.query.environment);
    const active = sanitizeQueryParam(req.query.active);

    // Build query
    const query: any = {};
    if (provider) query.provider = provider;
    if (environment) query.environment = environment;
    if (active !== undefined) query.isActive = active === 'true';

    // Get keys (exclude keyHash and key for security)
    const keys = await ProviderKey.find(query)
      .select('-keyHash -key')
      .sort({ provider: 1, priority: 1 });

    res.json({
      success: true,
      count: keys.length,
      data: keys,
    });
  } catch (error: any) {
    log.keys.error({ err: error }, 'Error listing keys');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /v1/keys/diagnostics
 * Check if all keys have stored key values and are usable
 */
router.get('/diagnostics', async (req: Request, res: Response) => {
  try {
    const keys = await ProviderKey.find({ isArchived: false }).select(
      'name provider keyPrefix isActive key isPaid currentPriority totalRequests successCount totalFailures lastFailureReason creditLimitUSD spentUSD'
    );

    const diagnostics = keys.map((k: any) => ({
      name: k.name,
      provider: k.provider,
      keyPrefix: k.keyPrefix,
      isActive: k.isActive,
      hasKeyValue: !!k.key,
      keyLength: k.key ? k.key.length : 0,
      isPaid: k.isPaid,
      currentPriority: k.currentPriority,
      totalRequests: k.totalRequests,
      successCount: k.successCount,
      totalFailures: k.totalFailures,
      lastFailureReason: k.lastFailureReason || null,
      creditLimitUSD: k.creditLimitUSD ?? null,
      spentUSD: k.spentUSD || 0,
      creditExhausted: k.creditLimitUSD != null && k.spentUSD >= k.creditLimitUSD,
    }));

    const issues: string[] = [];
    for (const d of diagnostics) {
      if (!d.hasKeyValue) {
        issues.push(`Key "${d.name}" (${d.provider}) has no stored key value`);
      }
      if (!d.isActive) {
        issues.push(`Key "${d.name}" (${d.provider}) is inactive`);
      }
    }

    res.json({
      success: true,
      data: {
        totalKeys: diagnostics.length,
        keysWithValues: diagnostics.filter((d: any) => d.hasKeyValue).length,
        activeKeys: diagnostics.filter((d: any) => d.isActive).length,
        issues,
        keys: diagnostics,
      },
    });
  } catch (error: any) {
    log.keys.error({ err: error }, 'Error running key diagnostics');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
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

    const key = await ProviderKey.findById(keyId).select('-keyHash -key');

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
    log.keys.error({ err: error }, 'Error getting key');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
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
    const { name, provider, key, environment, isPaid, tier, priority, rateLimit, creditLimitUSD, rateLimitResetMs } = req.body;

    // Validate required fields
    if (!name || !provider || !key) {
      return res.status(400).json({
        success: false,
        error: 'name, provider, and key are required',
        code: 'INVALID_REQUEST',
      });
    }

    // Validate field types and lengths
    const sanitizedName = sanitizeString(name, 100);
    if (!sanitizedName) {
      return res.status(400).json({
        success: false,
        error: 'name must be a non-empty string (max 100 chars)',
        code: 'INVALID_REQUEST',
      });
    }

    const sanitizedProvider = sanitizeString(provider, 50);
    if (!sanitizedProvider || !VALID_PROVIDERS.includes(sanitizedProvider.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}`,
        code: 'INVALID_REQUEST',
      });
    }

    if (typeof key !== 'string' || key.length < 10 || key.length > 500) {
      return res.status(400).json({
        success: false,
        error: 'key must be a string between 10 and 500 characters',
        code: 'INVALID_REQUEST',
      });
    }

    if (priority !== undefined && (typeof priority !== 'number' || priority < 0 || priority > 100)) {
      return res.status(400).json({
        success: false,
        error: 'priority must be a number between 0 and 100',
        code: 'INVALID_REQUEST',
      });
    }

    if (creditLimitUSD !== undefined && creditLimitUSD !== null && (typeof creditLimitUSD !== 'number' || creditLimitUSD < 0)) {
      return res.status(400).json({
        success: false,
        error: 'creditLimitUSD must be a non-negative number or null',
        code: 'INVALID_REQUEST',
      });
    }

    // Hash the key for deduplication
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

    // Create new key (use sanitized values, not raw req.body)
    const newKey = await ProviderKey.create({
      name: sanitizedName,
      provider: sanitizedProvider.toLowerCase(),
      keyHash,
      keyPrefix,
      key,
      environment: environment || 'production',
      isPaid: isPaid || false,
      tier: tier || 'free',
      currentPriority: priority || 10,
      originalPriority: priority || 10,
      rateLimit: rateLimit || {},
      creditLimitUSD: creditLimitUSD ?? null,
      rateLimitResetMs: rateLimitResetMs ?? null,
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

    broadcastKeysUpdate(provider);
  } catch (error: any) {
    log.keys.error({ err: error, body: { name: req.body?.name, provider: req.body?.provider } }, 'Error adding key');
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
        code: 'VALIDATION_ERROR',
      });
    }
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
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

    // Allowlist of fields that can be updated via PATCH
    const ALLOWED_FIELDS = ['name', 'isActive', 'priority', 'rateLimit', 'environment', 'isPaid', 'tier', 'creditLimitUSD', 'rateLimitResetMs'];
    const updates: Record<string, unknown> = {};
    for (const field of ALLOWED_FIELDS) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid fields to update',
        code: 'INVALID_REQUEST',
      });
    }

    const key = await ProviderKey.findByIdAndUpdate(
      keyId,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-keyHash -key');

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

    broadcastKeysUpdate(key.provider);
  } catch (error: any) {
    log.keys.error({ err: error }, 'Error updating key');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
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

    broadcastKeysUpdate(key.provider);
  } catch (error: any) {
    log.keys.error({ err: error }, 'Error deleting key');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
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

    if (!newKey || typeof newKey !== 'string' || newKey.length < 10 || newKey.length > 500) {
      return res.status(400).json({
        success: false,
        error: 'newKey must be a string between 10 and 500 characters',
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
    key.key = newKey;
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

    broadcastKeysUpdate(key.provider);
  } catch (error: any) {
    log.keys.error({ err: error }, 'Error rotating key');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/keys/:keyId/reset-spend
 * Reset spentUSD to 0 (e.g., after adding credit to a provider account)
 */
router.post('/:keyId/reset-spend', async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;

    const key = await ProviderKey.findByIdAndUpdate(
      keyId,
      { $set: { spentUSD: 0 } },
      { new: true }
    ).select('-keyHash -key');

    if (!key) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND',
      });
    }

    // Invalidate cache so the key becomes selectable again
    invalidateKeyCache(key.provider);

    res.json({
      success: true,
      data: key,
      message: 'Key spend reset successfully',
    });

    broadcastKeysUpdate(key.provider);
  } catch (error: any) {
    log.keys.error({ err: error }, 'Error resetting key spend');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
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
    ).select('-keyHash -key');

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

    broadcastKeysUpdate(key.provider);
  } catch (error: any) {
    log.keys.error({ err: error }, 'Error deactivating key');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
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
    ).select('-keyHash -key');

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

    broadcastKeysUpdate(key.provider);
  } catch (error: any) {
    log.keys.error({ err: error }, 'Error activating key');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
