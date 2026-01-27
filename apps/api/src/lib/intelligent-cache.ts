/**
 * Intelligent Caching Layer
 *
 * Caches AI responses with prompt fingerprinting for massive cost savings.
 * Supports both exact matching and semantic similarity matching.
 */

import crypto from 'crypto';
import { connectDB } from './db.js';
import mongoose from 'mongoose';

// ============== TYPES ==============

export interface CacheEntry {
  key: string;
  promptHash: string;
  model: string;
  messages: any[];
  response: any;
  tokensUsed: number;
  costSaved: number;
  hitCount: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface CacheStats {
  totalHits: number;
  totalMisses: number;
  hitRate: number;
  totalCostSaved: number;
  totalTokensSaved: number;
  cacheSize: number;
}

// ============== CONFIGURATION ==============

const CACHE_CONFIG = {
  enabled: true,
  defaultTTL: 3600, // 1 hour in seconds
  maxCacheSize: 10000, // Max entries before cleanup
  semanticSimilarityThreshold: 0.85, // For future semantic matching
  excludeSystemPrompt: false, // Include system prompt in cache key
};

// ============== MONGODB SCHEMA ==============

const CacheEntrySchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  promptHash: { type: String, required: true, index: true },
  model: { type: String, required: true, index: true },
  messages: { type: mongoose.Schema.Types.Mixed, required: true },
  response: { type: mongoose.Schema.Types.Mixed, required: true },
  tokensUsed: { type: Number, default: 0 },
  costSaved: { type: Number, default: 0 },
  hitCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, required: true, index: true }
}, {
  timestamps: true
});

// TTL index - MongoDB automatically deletes expired entries
CacheEntrySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const CacheEntryModel = mongoose.model('CacheEntry', CacheEntrySchema);

// ============== CACHE STATISTICS ==============

const CacheStatsSchema = new mongoose.Schema({
  _id: { type: String, default: 'global' },
  totalHits: { type: Number, default: 0 },
  totalMisses: { type: Number, default: 0 },
  totalCostSaved: { type: Number, default: 0 },
  totalTokensSaved: { type: Number, default: 0 },
  lastReset: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const CacheStatsModel = mongoose.model('CacheStats', CacheStatsSchema);

// ============== IN-MEMORY CACHE ==============

// Hot cache for extremely fast lookups (last 1000 entries)
const hotCache = new Map<string, {
  response: any;
  expiresAt: number;
  tokensUsed: number;
  costSaved: number;
}>();

const HOT_CACHE_MAX_SIZE = 1000;
const HOT_CACHE_CHECK_INTERVAL = 60000; // Clean every minute

// Clean expired entries from hot cache
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of hotCache.entries()) {
    if (value.expiresAt < now) {
      hotCache.delete(key);
    }
  }
}, HOT_CACHE_CHECK_INTERVAL);

// ============== CACHE KEY GENERATION ==============

/**
 * Generate a deterministic cache key from messages and model
 */
function generateCacheKey(messages: any[], model: string, temperature?: number): string {
  // Normalize messages to ensure consistent hashing
  const normalized = messages.map(msg => ({
    role: msg.role,
    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    tool_calls: msg.tool_calls,
    tool_call_id: msg.tool_call_id
  }));

  const payload = {
    messages: normalized,
    model,
    temperature: temperature || 0.7
  };

  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');

  return `cache:${model}:${hash}`;
}

/**
 * Generate a simpler hash for prompt similarity matching
 */
function generatePromptHash(messages: any[]): string {
  // Only hash user messages for similarity
  const userMessages = messages
    .filter(m => m.role === 'user')
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
    .join('\n');

  return crypto
    .createHash('md5')
    .update(userMessages)
    .digest('hex')
    .substring(0, 16); // Shorter hash for indexing
}

// ============== CACHE OPERATIONS ==============

/**
 * Get cached response
 */
export async function getCachedResponse(
  messages: any[],
  model: string,
  temperature?: number
): Promise<{ response: any; hit: boolean; tokensUsed?: number; costSaved?: number } | null> {
  if (!CACHE_CONFIG.enabled) {
    return null;
  }

  const key = generateCacheKey(messages, model, temperature);

  // Check hot cache first (in-memory, instant)
  const hotEntry = hotCache.get(key);
  if (hotEntry && hotEntry.expiresAt > Date.now()) {
    console.log(`[Cache] 🔥 HOT CACHE HIT for model ${model}`);
    await incrementCacheHit(hotEntry.costSaved, hotEntry.tokensUsed);
    return {
      response: hotEntry.response,
      hit: true,
      tokensUsed: hotEntry.tokensUsed,
      costSaved: hotEntry.costSaved
    };
  }

  // Check MongoDB cache
  try {
    await connectDB();
    const entry = await CacheEntryModel.findOne({
      key,
      expiresAt: { $gt: new Date() }
    });

    if (entry) {
      console.log(`[Cache] ✅ CACHE HIT for model ${model} (saved ${entry.tokensUsed} tokens, $${entry.costSaved.toFixed(4)})`);

      // Update hit count and stats
      entry.hitCount++;
      await entry.save();
      await incrementCacheHit(entry.costSaved, entry.tokensUsed);

      // Add to hot cache for future fast access
      if (hotCache.size < HOT_CACHE_MAX_SIZE) {
        hotCache.set(key, {
          response: entry.response,
          expiresAt: entry.expiresAt.getTime(),
          tokensUsed: entry.tokensUsed,
          costSaved: entry.costSaved
        });
      }

      return {
        response: entry.response,
        hit: true,
        tokensUsed: entry.tokensUsed,
        costSaved: entry.costSaved
      };
    }

    // Cache miss
    console.log(`[Cache] ❌ CACHE MISS for model ${model}`);
    await incrementCacheMiss();
    return null;
  } catch (error) {
    console.error('[Cache] Error getting cached response:', error);
    return null;
  }
}

/**
 * Store response in cache
 */
export async function setCachedResponse(
  messages: any[],
  model: string,
  response: any,
  tokensUsed: number,
  costSaved: number,
  temperature?: number,
  ttlSeconds?: number
): Promise<void> {
  if (!CACHE_CONFIG.enabled) {
    return;
  }

  const key = generateCacheKey(messages, model, temperature);
  const promptHash = generatePromptHash(messages);
  const ttl = ttlSeconds || CACHE_CONFIG.defaultTTL;
  const expiresAt = new Date(Date.now() + ttl * 1000);

  try {
    await connectDB();

    // Store in MongoDB
    await CacheEntryModel.findOneAndUpdate(
      { key },
      {
        key,
        promptHash,
        model,
        messages,
        response,
        tokensUsed,
        costSaved,
        hitCount: 0,
        createdAt: new Date(),
        expiresAt
      },
      { upsert: true, new: true }
    );

    // Store in hot cache
    if (hotCache.size < HOT_CACHE_MAX_SIZE) {
      hotCache.set(key, {
        response,
        expiresAt: expiresAt.getTime(),
        tokensUsed,
        costSaved
      });
    } else if (hotCache.size >= HOT_CACHE_MAX_SIZE) {
      // Remove oldest entry to make room
      const oldestKey = hotCache.keys().next().value;
      if (oldestKey) hotCache.delete(oldestKey);
      hotCache.set(key, {
        response,
        expiresAt: expiresAt.getTime(),
        tokensUsed,
        costSaved
      });
    }

    console.log(`[Cache] 💾 Cached response for model ${model} (expires in ${ttl}s, saves ${tokensUsed} tokens)`);

    // Check if we need cache cleanup
    const cacheSize = await CacheEntryModel.countDocuments();
    if (cacheSize > CACHE_CONFIG.maxCacheSize) {
      await cleanupOldEntries();
    }
  } catch (error) {
    console.error('[Cache] Error storing cached response:', error);
  }
}

/**
 * Invalidate cache entries for a specific model or all
 */
export async function invalidateCache(model?: string): Promise<number> {
  try {
    await connectDB();
    const filter = model ? { model } : {};
    const result = await CacheEntryModel.deleteMany(filter);

    // Clear hot cache
    if (model) {
      for (const [key, value] of hotCache.entries()) {
        if (key.includes(model)) {
          hotCache.delete(key);
        }
      }
    } else {
      hotCache.clear();
    }

    console.log(`[Cache] 🗑️ Invalidated ${result.deletedCount} cache entries${model ? ` for model ${model}` : ''}`);
    return result.deletedCount;
  } catch (error) {
    console.error('[Cache] Error invalidating cache:', error);
    return 0;
  }
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<CacheStats> {
  try {
    await connectDB();
    let stats = await CacheStatsModel.findById('global');

    if (!stats) {
      stats = await CacheStatsModel.create({
        _id: 'global',
        totalHits: 0,
        totalMisses: 0,
        totalCostSaved: 0,
        totalTokensSaved: 0,
        lastReset: new Date()
      });
    }

    const cacheSize = await CacheEntryModel.countDocuments();
    const hitRate = stats.totalHits + stats.totalMisses > 0
      ? (stats.totalHits / (stats.totalHits + stats.totalMisses)) * 100
      : 0;

    return {
      totalHits: stats.totalHits,
      totalMisses: stats.totalMisses,
      hitRate,
      totalCostSaved: stats.totalCostSaved,
      totalTokensSaved: stats.totalTokensSaved,
      cacheSize
    };
  } catch (error) {
    console.error('[Cache] Error getting cache stats:', error);
    return {
      totalHits: 0,
      totalMisses: 0,
      hitRate: 0,
      totalCostSaved: 0,
      totalTokensSaved: 0,
      cacheSize: 0
    };
  }
}

/**
 * Reset cache statistics
 */
export async function resetCacheStats(): Promise<void> {
  try {
    await connectDB();
    await CacheStatsModel.findByIdAndUpdate('global', {
      totalHits: 0,
      totalMisses: 0,
      totalCostSaved: 0,
      totalTokensSaved: 0,
      lastReset: new Date()
    }, { upsert: true });
    console.log('[Cache] 📊 Cache stats reset');
  } catch (error) {
    console.error('[Cache] Error resetting cache stats:', error);
  }
}

// ============== INTERNAL HELPERS ==============

async function incrementCacheHit(costSaved: number, tokensSaved: number): Promise<void> {
  try {
    await connectDB();
    await CacheStatsModel.findByIdAndUpdate(
      'global',
      {
        $inc: {
          totalHits: 1,
          totalCostSaved: costSaved,
          totalTokensSaved: tokensSaved
        },
        $set: { updatedAt: new Date() }
      },
      { upsert: true }
    );
  } catch (error) {
    console.error('[Cache] Error incrementing cache hit:', error);
  }
}

async function incrementCacheMiss(): Promise<void> {
  try {
    await connectDB();
    await CacheStatsModel.findByIdAndUpdate(
      'global',
      {
        $inc: { totalMisses: 1 },
        $set: { updatedAt: new Date() }
      },
      { upsert: true }
    );
  } catch (error) {
    console.error('[Cache] Error incrementing cache miss:', error);
  }
}

async function cleanupOldEntries(): Promise<void> {
  try {
    await connectDB();
    // Delete oldest 20% of entries
    const entriesToDelete = Math.floor(CACHE_CONFIG.maxCacheSize * 0.2);
    const oldEntries = await CacheEntryModel.find()
      .sort({ createdAt: 1 })
      .limit(entriesToDelete)
      .select('_id key');

    const idsToDelete = oldEntries.map(e => e._id);
    const keysToDelete = oldEntries.map(e => e.key);

    await CacheEntryModel.deleteMany({ _id: { $in: idsToDelete } });

    // Clear from hot cache
    keysToDelete.forEach(key => hotCache.delete(key));

    console.log(`[Cache] 🧹 Cleaned up ${entriesToDelete} old cache entries`);
  } catch (error) {
    console.error('[Cache] Error cleaning up old entries:', error);
  }
}

// ============== CACHE CONFIGURATION ==============

export function setCacheEnabled(enabled: boolean): void {
  CACHE_CONFIG.enabled = enabled;
  console.log(`[Cache] Cache ${enabled ? 'enabled' : 'disabled'}`);
}

export function setCacheTTL(ttlSeconds: number): void {
  CACHE_CONFIG.defaultTTL = ttlSeconds;
  console.log(`[Cache] Default TTL set to ${ttlSeconds}s`);
}

export function isCacheEnabled(): boolean {
  return CACHE_CONFIG.enabled;
}
