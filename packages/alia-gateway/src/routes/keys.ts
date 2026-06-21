/**
 * Keys API Routes (Admin Only)
 * Handles provider API key management
 */

import express, { Request, Response } from 'express';
import crypto from 'crypto';
import type { AnyBulkWriteOperation } from 'mongoose';
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

// ============== EXPORT/IMPORT HELPERS ==============

const EXPORT_VERSION = 1;
const EXPORT_FORMAT = 'alia-keys-export';
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha512';
const PBKDF2_KEY_LENGTH = 32;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const MIN_PASSPHRASE_LENGTH = 12;

const EXPORT_SELECT_FIELDS = [
  'name', 'provider', 'environment', 'key', 'keyPrefix',
  'rateLimit', 'isActive', 'isPaid', 'tier',
  'currentPriority', 'originalPriority',
  'creditLimitUSD', 'spentUSD', 'rateLimitResetMs',
  'maxTotalFailures', 'rotationSchedule',
  'ownerId', 'organizationId',
].join(' ');

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST);
}

function encryptPayload(plaintext: string, passphrase: string): { salt: string; iv: string; authTag: string; ciphertext: string } {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: encrypted.toString('hex'),
  };
}

function decryptPayload(ciphertext: string, salt: string, iv: string, authTag: string, passphrase: string): string {
  const key = deriveKey(passphrase, Buffer.from(salt, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
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
  } catch (error: unknown) {
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
    const query: Record<string, unknown> = {};
    if (provider) query.provider = provider;
    if (environment) query.environment = environment;
    if (active !== undefined) query.isActive = active === 'true';

    // Get keys (exclude keyHash and key for security)
    const keys = await ProviderKey.find(query)
      .select('-keyHash -key')
      .sort({ provider: 1, priority: 1 })
      .lean();

    res.json({
      success: true,
      count: keys.length,
      data: keys,
    });
  } catch (error: unknown) {
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
    ).lean();

    const diagnostics = keys.map((k: Record<string, unknown>) => {
      const keyVal = typeof k.key === 'string' ? k.key : null;
      const spentUSD = typeof k.spentUSD === 'number' ? k.spentUSD : 0;
      const creditLimitUSD = typeof k.creditLimitUSD === 'number' ? k.creditLimitUSD : null;
      return {
        name: k.name,
        provider: k.provider,
        keyPrefix: k.keyPrefix,
        isActive: k.isActive,
        hasKeyValue: !!keyVal,
        keyLength: keyVal ? keyVal.length : 0,
        isPaid: k.isPaid,
        currentPriority: k.currentPriority,
        totalRequests: k.totalRequests,
        successCount: k.successCount,
        totalFailures: k.totalFailures,
        lastFailureReason: k.lastFailureReason || null,
        creditLimitUSD: creditLimitUSD ?? null,
        spentUSD,
        creditExhausted: creditLimitUSD != null && spentUSD >= creditLimitUSD,
      };
    });

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
        keysWithValues: diagnostics.filter((d) => d.hasKeyValue).length,
        activeKeys: diagnostics.filter((d) => d.isActive).length,
        issues,
        keys: diagnostics,
      },
    });
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Error running key diagnostics');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/keys/export
 * Export provider keys as an encrypted payload for backup/migration
 */
router.post('/export', async (req: Request, res: Response) => {
  try {
    const { passphrase, provider, environment } = req.body;

    if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
      return res.status(400).json({
        success: false,
        error: `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
        code: 'INVALID_REQUEST',
      });
    }

    // Build query (same pattern as GET /)
    const query: Record<string, unknown> = { isArchived: false };
    const sanitizedProvider = provider ? sanitizeString(provider, 50) : null;
    if (sanitizedProvider) query.provider = sanitizedProvider.toLowerCase();
    const sanitizedEnv = environment ? sanitizeString(environment, 20) : null;
    if (sanitizedEnv) query.environment = sanitizedEnv;

    const keys = await ProviderKey.find(query).select(EXPORT_SELECT_FIELDS).lean();

    if (keys.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No keys found matching the specified filters',
        code: 'NO_KEYS_FOUND',
      });
    }

    // Strip MongoDB internals
    const exportKeys = keys.map((k: Record<string, unknown>) => {
      const { _id, __v, ...config } = k;
      return config;
    });

    const plaintext = JSON.stringify(exportKeys);
    const { salt, iv, authTag, ciphertext } = encryptPayload(plaintext, passphrase);

    const filters: Record<string, string> = {};
    if (sanitizedProvider) filters.provider = sanitizedProvider;
    if (sanitizedEnv) filters.environment = sanitizedEnv;

    const exportPayload = {
      version: EXPORT_VERSION,
      format: EXPORT_FORMAT,
      metadata: {
        exportedAt: new Date().toISOString(),
        keyCount: exportKeys.length,
        filters,
      },
      encryption: {
        algorithm: 'aes-256-gcm',
        kdf: 'pbkdf2',
        kdfParams: {
          iterations: PBKDF2_ITERATIONS,
          digest: PBKDF2_DIGEST,
          saltLength: SALT_LENGTH,
        },
        salt,
        iv,
        authTag,
      },
      data: ciphertext,
    };

    log.keys.info({ keyCount: exportKeys.length, filters }, 'Keys exported');

    res.json({ success: true, data: exportPayload });
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Error exporting keys');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /v1/keys/import
 * Import provider keys from an encrypted export payload
 */
router.post('/import', async (req: Request, res: Response) => {
  try {
    const { passphrase, payload, onConflict = 'skip' } = req.body;

    // Validate inputs
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Passphrase is required',
        code: 'INVALID_REQUEST',
      });
    }

    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Encrypted payload is required',
        code: 'INVALID_REQUEST',
      });
    }

    const validConflictStrategies = ['skip', 'overwrite', 'error'];
    if (!validConflictStrategies.includes(onConflict)) {
      return res.status(400).json({
        success: false,
        error: `onConflict must be one of: ${validConflictStrategies.join(', ')}`,
        code: 'INVALID_REQUEST',
      });
    }

    // Check version
    if (payload.version !== EXPORT_VERSION || payload.format !== EXPORT_FORMAT) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported export format or version',
        code: 'UNSUPPORTED_VERSION',
      });
    }

    // Validate encryption fields
    const { encryption, data } = payload;
    if (!encryption?.salt || !encryption?.iv || !encryption?.authTag || !data) {
      return res.status(400).json({
        success: false,
        error: 'Payload is missing required encryption fields',
        code: 'INVALID_REQUEST',
      });
    }

    // Decrypt
    let decryptedKeys: Array<Record<string, unknown>>;
    try {
      const plaintext = decryptPayload(data, encryption.salt, encryption.iv, encryption.authTag, passphrase);
      decryptedKeys = JSON.parse(plaintext);
    } catch {
      return res.status(400).json({
        success: false,
        error: 'Decryption failed — invalid passphrase or corrupted data',
        code: 'DECRYPTION_FAILED',
      });
    }

    if (!Array.isArray(decryptedKeys) || decryptedKeys.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Decrypted payload must be a non-empty array of keys',
        code: 'INVALID_REQUEST',
      });
    }

    // Validate all keys before any writes
    const validationErrors: string[] = [];
    const processedKeys: Array<{
      doc: Record<string, unknown>;
      keyHash: string;
      keyPrefix: string;
    }> = [];

    for (let i = 0; i < decryptedKeys.length; i++) {
      const k = decryptedKeys[i];
      const prefix = `Key[${i}]`;

      const name = sanitizeString(k.name as string, 100);
      if (!name) {
        validationErrors.push(`${prefix}: name must be a non-empty string (max 100 chars)`);
        continue;
      }

      const provider = sanitizeString(k.provider as string, 50);
      if (!provider || !VALID_PROVIDERS.includes(provider.toLowerCase())) {
        validationErrors.push(`${prefix} "${name}": invalid provider`);
        continue;
      }

      const keyValue = k.key;
      if (typeof keyValue !== 'string' || keyValue.length < 10 || keyValue.length > 500) {
        validationErrors.push(`${prefix} "${name}": key must be a string between 10 and 500 characters`);
        continue;
      }

      const keyHash = crypto.createHash('sha256').update(keyValue).digest('hex');
      const keyPrefix = keyValue.substring(0, Math.min(8, keyValue.length)) + '...';

      processedKeys.push({
        doc: {
          name,
          provider: provider.toLowerCase(),
          keyHash,
          keyPrefix,
          key: keyValue,
          environment: k.environment || 'production',
          isPaid: typeof k.isPaid === 'boolean' ? k.isPaid : false,
          tier: k.tier || 'free',
          currentPriority: typeof k.currentPriority === 'number' ? k.currentPriority : 10,
          originalPriority: typeof k.originalPriority === 'number' ? k.originalPriority : 10,
          rateLimit: k.rateLimit || {},
          creditLimitUSD: typeof k.creditLimitUSD === 'number' ? k.creditLimitUSD : null,
          spentUSD: typeof k.spentUSD === 'number' ? k.spentUSD : 0,
          rateLimitResetMs: typeof k.rateLimitResetMs === 'number' ? k.rateLimitResetMs : null,
          maxTotalFailures: typeof k.maxTotalFailures === 'number' ? k.maxTotalFailures : 100,
          rotationSchedule: k.rotationSchedule || 'manual',
          isActive: typeof k.isActive === 'boolean' ? k.isActive : true,
          ownerId: k.ownerId || undefined,
          organizationId: k.organizationId || undefined,
        },
        keyHash,
        keyPrefix,
      });
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed for one or more keys',
        code: 'VALIDATION_FAILED',
        details: validationErrors,
      });
    }

    // Check for duplicates in batch
    const allKeyHashes = processedKeys.map((k) => k.keyHash);
    const existingKeys = await ProviderKey.find({ keyHash: { $in: allKeyHashes } }).select('keyHash name provider').lean();
    const existingHashSet = new Map(existingKeys.map((k: Record<string, unknown>) => [k.keyHash as string, k]));

    // Apply conflict strategy
    if (onConflict === 'error' && existingHashSet.size > 0) {
      const conflicts = processedKeys
        .filter((k) => existingHashSet.has(k.keyHash))
        .map((k) => (k.doc.name as string));
      return res.status(409).json({
        success: false,
        error: `${conflicts.length} key(s) already exist`,
        code: 'KEY_CONFLICT',
        conflicts,
      });
    }

    // Build bulk operations
    const operations: AnyBulkWriteOperation<Record<string, unknown>>[] = [];
    let skipped = 0;
    let updated = 0;

    for (const entry of processedKeys) {
      if (existingHashSet.has(entry.keyHash)) {
        if (onConflict === 'skip') {
          skipped++;
          continue;
        }
        // overwrite
        const { keyHash, key, ...updateFields } = entry.doc;
        operations.push({
          updateOne: {
            filter: { keyHash: entry.keyHash },
            update: { $set: updateFields as Record<string, unknown> },
          },
        });
        updated++;
      } else {
        operations.push({ insertOne: { document: entry.doc } });
      }
    }

    if (operations.length > 0) {
      await ProviderKey.bulkWrite(operations);
    }

    const imported = operations.length - updated;

    // Invalidate caches for all affected providers
    invalidateKeyCache();
    clearHealthCache();

    const affectedProviders = [...new Set(processedKeys.map((k) => k.doc.provider as string))];
    for (const provider of affectedProviders) {
      broadcastKeysUpdate(provider);
    }

    log.keys.info(
      { total: processedKeys.length, imported, updated, skipped, providers: affectedProviders },
      'Keys imported'
    );

    res.json({
      success: true,
      data: {
        total: processedKeys.length,
        imported,
        updated,
        skipped,
        providers: affectedProviders,
      },
    });
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Error importing keys');
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
  } catch (error: unknown) {
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
  } catch (error: unknown) {
    log.keys.error({ err: error, body: { name: req.body?.name, provider: req.body?.provider } }, 'Error adding key');
    if (error instanceof Error && error.name === 'ValidationError') {
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
      { returnDocument: 'after', runValidators: true }
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
  } catch (error: unknown) {
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
  } catch (error: unknown) {
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
  } catch (error: unknown) {
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
      { returnDocument: 'after' }
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
  } catch (error: unknown) {
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
      { returnDocument: 'after' }
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
  } catch (error: unknown) {
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
      { returnDocument: 'after' }
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
  } catch (error: unknown) {
    log.keys.error({ err: error }, 'Error activating key');
    res.status(500).json({
      success: false,
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
    });
  }
});

export default router;
