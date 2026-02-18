import { Router, Request, Response } from 'express';
import { generateText } from 'ai';
import { Suggestion } from '../models/suggestion.js';
import { UserMemory } from '../models/user-memory.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../lib/chat-core.js';
import { log } from '../lib/logger.js';

const router = Router();

// ============== IN-MEMORY CACHE ==============

const cache = new Map<string, { data: any; expiresAt: number }>();
const CACHE_MAX_SIZE = 500;
const SEARCH_CACHE_TTL = 3 * 60 * 1000; // 3 min — autocomplete results

function cacheGet(key: string): any | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key: string, data: any, ttl: number): void {
  // Evict oldest if full
  if (cache.size >= CACHE_MAX_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { data, expiresAt: Date.now() + ttl });
}

// Periodic cleanup every 2 min
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt < now) cache.delete(key);
  }
}, 2 * 60 * 1000);

/**
 * Helper: resolve user language from memory preferences, fallback to 'en'
 */
async function getUserLanguage(userId?: string): Promise<string> {
  if (!userId) return 'en';
  try {
    const memory = await UserMemory.findOne({ oxyUserId: userId })
      .select('preferences.language')
      .lean();
    return memory?.preferences?.language || 'en';
  } catch {
    return 'en';
  }
}

/** Filter condition to exclude expired suggestions */
function notExpiredFilter() {
  return { $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }] };
}

/**
 * POST /suggestions/list
 * List suggestions with filters. Language resolved server-side.
 * Body: { type?, category?, limit?, offset? }
 */
router.post('/list', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { type, category, limit = 200, offset = 0 } = req.body || {};
    const language = await getUserLanguage(req.user?.id);

    const filter: any = {
      language,
      $and: [
        notExpiredFilter(),
        { $or: [
          { scope: 'global' },
          ...(req.user?.id ? [{ scope: 'personal', oxyUserId: req.user.id }] : []),
        ]},
      ],
    };

    if (type && typeof type === 'string') {
      filter.type = type;
    }
    if (category && typeof category === 'string' && category !== 'all') {
      filter.category = category;
    }

    const suggestions = await Suggestion.find(filter)
      .sort({ priority: -1, usageCount: -1, title: 1 })
      .skip(Number(offset) || 0)
      .limit(Math.min(Number(limit) || 200, 500))
      .lean();

    res.json({ suggestions });
  } catch (error: any) {
    log.general.error({ err: error }, 'Error listing suggestions');
    res.status(500).json({ error: 'Failed to list suggestions' });
  }
});

/**
 * POST /suggestions/welcome
 * Get welcome card suggestions. Language resolved server-side.
 * Body: { count? }
 */
router.post('/welcome', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { count = 4 } = req.body || {};
    const language = await getUserLanguage(req.user?.id);

    // Base query: global welcome suggestions in user's language (exclude expired)
    const filter: any = {
      type: 'welcome',
      language,
      $and: [
        notExpiredFilter(),
        { $or: [
          { scope: 'global' },
          ...(req.user?.id ? [{ scope: 'personal', oxyUserId: req.user.id }] : []),
        ]},
      ],
    };

    const requestedCount = Math.min(Number(count) || 4, 20);

    // Fetch a larger pool to randomly pick from
    let pool = await Suggestion.find(filter)
      .sort({ priority: -1 })
      .limit(requestedCount * 5)
      .lean();

    // If authenticated, try to personalize scoring
    if (req.user?.id && pool.length > 0) {
      try {
        const memory = await UserMemory.findOne({ oxyUserId: req.user.id })
          .select('preferences.interests context.occupation')
          .lean();

        if (memory) {
          const userInterests = memory.preferences?.interests || [];
          const userOccupation = memory.context?.occupation || '';

          // Score by relevance to user profile
          pool = pool.map(s => {
            let score = (s.priority || 0) + Math.random() * 3;
            for (const interest of userInterests) {
              if (s.tags?.includes(interest) || s.interests?.includes(interest)) score += 5;
            }
            if (userOccupation && s.occupations?.includes(userOccupation)) score += 3;
            return { ...s, _score: score };
          })
          .sort((a: any, b: any) => b._score - a._score)
          .map(({ _score, ...rest }: any) => rest);
        }
      } catch {
        // Personalization is best-effort
      }
    } else {
      // Unauthenticated: shuffle the pool randomly
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
    }

    // Pick requested count from the (scored or shuffled) pool
    const suggestions = pool.slice(0, requestedCount);

    res.json({ suggestions });
  } catch (error: any) {
    log.general.error({ err: error }, 'Error getting welcome suggestions');
    res.status(500).json({ error: 'Failed to get welcome suggestions' });
  }
});

/**
 * POST /suggestions/me
 * List current user's personal suggestions (authenticated)
 */
router.post('/me', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const suggestions = await Suggestion.find({ oxyUserId: req.user.id, scope: 'personal' })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ suggestions });
  } catch (error: any) {
    log.general.error({ err: error }, 'Error listing user suggestions');
    res.status(500).json({ error: 'Failed to list your suggestions' });
  }
});

/**
 * POST /suggestions/create
 * Create a personal suggestion (authenticated)
 */
router.post('/create', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { title, text, description, type, category, triggerWords, tags, expiresAt } = req.body;

    if (!title || !text || !type) {
      return res.status(400).json({ error: 'title, text, and type are required' });
    }

    // Generate suggestionId
    let suggestionId = `user-${title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 40)}-${Date.now().toString(36).slice(-4)}`;

    const suggestion = await Suggestion.create({
      suggestionId,
      title,
      text,
      description: description || '',
      type,
      category: category || 'general',
      triggerWords: triggerWords || [],
      tags: tags || [],
      scope: 'personal',
      language: await getUserLanguage(req.user.id),
      isBuiltIn: false,
      isAIGenerated: false,
      oxyUserId: req.user.id,
      ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
    });

    res.status(201).json({ suggestion });
  } catch (error: any) {
    log.general.error({ err: error }, 'Error creating suggestion');
    res.status(500).json({ error: 'Failed to create suggestion' });
  }
});

/**
 * POST /suggestions/generate
 * AI-generate personalized suggestions (authenticated)
 * Body: { count?, types? }
 */
router.post('/generate', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { count = 6, types = ['welcome', 'autocomplete'] } = req.body;

    // Fetch user context for personalization
    const memory = await UserMemory.findOne({ oxyUserId: req.user.id })
      .select('preferences context')
      .lean();

    const language = memory?.preferences?.language || 'en';
    const interests = memory?.preferences?.interests || [];
    const tone = memory?.preferences?.tone || 'friendly';
    const occupation = memory?.context?.occupation || '';
    const location = memory?.context?.location || '';

    // Provider fallback retry loop
    const MAX_PROVIDER_RETRIES = 3;
    const skipProviders = new Set<string>();
    let result: Awaited<ReturnType<typeof generateText>> | null = null;

    for (let attempt = 0; attempt < MAX_PROVIDER_RETRIES; attempt++) {
      const resolved = await resolveModel(getDefaultAliaModel(), skipProviders);
      if (!resolved) {
        if (attempt === 0) {
          return res.status(503).json({ error: 'No AI models available' });
        }
        break;
      }

      try {
        const model = getAIModel(resolved.keyConfig);
        result = await generateText({
          model,
          messages: [
            {
              role: 'system',
              content: `You are a suggestion generator for an AI assistant app. Generate ${count} personalized prompt suggestions for the user based on their profile.

User profile:
- Language: ${language}
- Interests: ${interests.join(', ') || 'general'}
- Tone preference: ${tone}
- Occupation: ${occupation || 'not specified'}
- Location: ${location || 'not specified'}

Generate a JSON array of suggestion objects. Each suggestion should have:
- "title": Short label (2-4 words)
- "text": Full prompt text the user would send
- "description": One-sentence explanation
- "type": One of: ${types.map((t: string) => `"${t}"`).join(', ')}
- "category": A category string (e.g., "productivity", "coding", "creative", "communication", "learning")
- "triggerWords": Array of 1-3 trigger words for autocomplete matching
- "tags": Array of 2-3 relevant tags
- "occupations": Array of relevant occupations (can be empty)
- "interests": Array of relevant interests

The text may include {variable} template placeholders where the user would fill in their own content (e.g., "Translate {text} into {language}").

Write ALL text content in: ${language}

Mix suggestion types across the requested types. Make them specific, actionable, and relevant to the user's profile.

Return ONLY valid JSON array, no other text.`,
            },
            {
              role: 'user',
              content: `Generate ${count} personalized suggestions for me.`,
            },
          ],
          temperature: 0.8,
          maxRetries: 0,
        });
        break;
      } catch (providerError: any) {
        log.general.error({ err: providerError, provider: resolved.provider, attempt }, 'Provider failed for suggestion generation');
        skipProviders.add(resolved.provider);
        if (attempt >= MAX_PROVIDER_RETRIES - 1) throw providerError;
      }
    }

    if (!result) {
      return res.status(503).json({ error: 'No AI models available' });
    }

    const responseText = result.text || '';

    // Parse JSON array from response
    let parsed: any[];
    try {
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('No JSON array found');
      parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) throw new Error('Not an array');
    } catch {
      log.general.error({ responseText }, 'Failed to parse AI-generated suggestions');
      return res.status(500).json({ error: 'Failed to generate suggestions' });
    }

    // Create suggestion documents
    const created = [];
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      if (!item.title || !item.text) continue;

      const slug = item.title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 40);
      const suggestionId = `ai-${slug}-${Date.now().toString(36).slice(-4)}-${i}`;

      try {
        const suggestion = await Suggestion.create({
          suggestionId,
          title: item.title,
          text: item.text,
          description: item.description || '',
          type: ['welcome', 'autocomplete'].includes(item.type) ? item.type : 'autocomplete',
          category: item.category || 'general',
          triggerWords: Array.isArray(item.triggerWords) ? item.triggerWords.slice(0, 5) : [],
          tags: Array.isArray(item.tags) ? item.tags.slice(0, 5) : [],
          occupations: Array.isArray(item.occupations) ? item.occupations.slice(0, 5) : [],
          interests: Array.isArray(item.interests) ? item.interests.slice(0, 5) : [],
          scope: 'personal',
          language,
          isBuiltIn: false,
          isAIGenerated: true,
          oxyUserId: req.user!.id,
        });
        created.push(suggestion);
      } catch (err) {
        log.general.error({ err, suggestionId }, 'Failed to create AI suggestion');
      }
    }

    res.json({ suggestions: created, generated: created.length });
  } catch (error: any) {
    log.general.error({ err: error }, 'Error generating suggestions');
    res.status(500).json({ error: 'Failed to generate suggestions' });
  }
});

/**
 * PATCH /suggestions/:id
 * Update own suggestion (authenticated, owner only, non-built-in)
 */
router.patch('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const suggestion = await Suggestion.findOne({
      suggestionId: req.params.id,
      oxyUserId: req.user.id,
      isBuiltIn: false,
    });

    if (!suggestion) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const allowedFields = [
      'title', 'text', 'description', 'type', 'category',
      'triggerWords', 'tags', 'expiresAt',
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        if (field === 'expiresAt') {
          (suggestion as any).expiresAt = req.body[field] ? new Date(req.body[field]) : null;
        } else {
          (suggestion as any)[field] = req.body[field];
        }
      }
    }

    await suggestion.save();
    res.json({ suggestion });
  } catch (error: any) {
    log.general.error({ err: error }, 'Error updating suggestion');
    res.status(500).json({ error: 'Failed to update suggestion' });
  }
});

/**
 * DELETE /suggestions/:id
 * Delete own suggestion (authenticated, owner only, non-built-in)
 */
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await Suggestion.deleteOne({
      suggestionId: req.params.id,
      oxyUserId: req.user.id,
      isBuiltIn: false,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    res.json({ success: true });
  } catch (error: any) {
    log.general.error({ err: error }, 'Error deleting suggestion');
    res.status(500).json({ error: 'Failed to delete suggestion' });
  }
});

/**
 * POST /suggestions/search
 * Real-time autocomplete search (Google-style). Debounced client-side.
 * Body: { query, limit? }
 */
router.post('/search', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { query, limit = 6 } = req.body || {};
    if (!query || typeof query !== 'string' || query.trim().length < 2) {
      return res.json({ suggestions: [] });
    }

    const trimmed = query.trim().toLowerCase();
    const language = await getUserLanguage(req.user?.id);
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const limitNum = Math.min(Number(limit) || 6, 20);

    const searchOr = [
      { triggerWords: { $regex: `^${escaped}`, $options: 'i' } },
      { title: { $regex: escaped, $options: 'i' } },
      { text: { $regex: escaped, $options: 'i' } },
    ];

    // 1. Global results — shared cache by query+language (serves all users)
    const globalCacheKey = `search:${trimmed}:${language}`;
    let globalResults = cacheGet(globalCacheKey);
    if (!globalResults) {
      globalResults = await Suggestion.find({
        language,
        scope: 'global',
        $and: [notExpiredFilter(), { $or: searchOr }],
      })
        .sort({ priority: -1, usageCount: -1 })
        .limit(limitNum)
        .select('suggestionId title text triggerWords isTemplate templateVariables')
        .lean();
      cacheSet(globalCacheKey, globalResults, SEARCH_CACHE_TTL);
    }

    // 2. Personal results — only for authenticated users, not cached
    let personalResults: any[] = [];
    if (req.user?.id) {
      personalResults = await Suggestion.find({
        language,
        scope: 'personal',
        oxyUserId: req.user.id,
        $and: [notExpiredFilter(), { $or: searchOr }],
      })
        .sort({ priority: -1, usageCount: -1 })
        .limit(limitNum)
        .select('suggestionId title text triggerWords isTemplate templateVariables')
        .lean();
    }

    // 3. Merge: personal first, then global, dedupe by suggestionId
    const seen = new Set<string>();
    const suggestions = [];
    for (const s of [...personalResults, ...globalResults]) {
      if (suggestions.length >= limitNum) break;
      if (!seen.has(s.suggestionId)) {
        seen.add(s.suggestionId);
        suggestions.push(s);
      }
    }

    res.json({ suggestions });
  } catch (error: any) {
    log.general.error({ err: error }, 'Error searching suggestions');
    res.status(500).json({ error: 'Failed to search suggestions' });
  }
});

/**
 * POST /suggestions/:id/use
 * Increment usage count (optional auth)
 */
router.post('/:id/use', optionalAuth, async (req: Request, res: Response) => {
  try {
    await Suggestion.updateOne(
      { suggestionId: req.params.id },
      { $inc: { usageCount: 1 } }
    );
    res.json({ success: true });
  } catch (error: any) {
    log.general.error({ err: error }, 'Error recording suggestion usage');
    res.status(500).json({ error: 'Failed to record usage' });
  }
});

export default router;
