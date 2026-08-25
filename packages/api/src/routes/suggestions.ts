import { Router, Request, Response } from 'express';
import { generateObject, NoObjectGeneratedError, zodSchema } from 'ai';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { findUserMemory } from '../db/memory/userMemoryRepository.js';
import {
  createSuggestion,
  deleteOwnSuggestion,
  findOwnSuggestion,
  incrementSuggestionUsage,
  listOwnSuggestions,
  listSuggestions,
  listWelcomePool,
  searchSuggestions,
  updateOwnSuggestion,
  type SuggestionPatch,
} from '../db/notifications/suggestionRepository.js';
import type { SuggestionSearchHit } from '../db/notifications/suggestionRepository.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { resolveModel, getAIModel } from '../lib/chat-core.js';
import { getUserLanguage } from '../lib/memory/user-memory-service.js';
import { log } from '../lib/logger.js';
import { generateTextViaKaana } from '../lib/inference/kaana-text.js';

const aiSuggestionSchema = z.object({
  title: z.string().min(1),
  text: z.string().min(1),
  description: z.string().optional().default(''),
  type: z.enum(['welcome', 'autocomplete']).catch('autocomplete'),
  category: z.string().optional().default('general'),
  language: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/).optional(),
  triggerWords: z.array(z.string()).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
  occupations: z.array(z.string()).optional().default([]),
  interests: z.array(z.string()).optional().default([]),
});

/**
 * The whole answer, as an OBJECT with the list inside it.
 *
 * Not a bare array, and the reason is the response format rather than taste:
 * the JSON-schema field every OpenAI-dialect provider implements takes an
 * object at the root and refuses an array there. Asking for a shape the model
 * is then told it may not produce is how a structured request becomes a
 * free-text one again.
 */
const aiSuggestionListSchema = z.object({
  suggestions: z.array(aiSuggestionSchema).min(1),
});

type AiSuggestion = z.infer<typeof aiSuggestionSchema>;

const SUGGESTION_TYPES = ['welcome', 'autocomplete'] as const;

/**
 * How many suggestions one call may ask for.
 *
 * The client asks for eight. The cap exists because `count` goes straight into
 * the prompt, and an unbounded one asks for an answer no output budget can hold
 * — which is the failure this route was already having at eight.
 */
const MAX_GENERATED_SUGGESTIONS = 10;

/**
 * The output budget, in tokens.
 *
 * Measured against `openai/gpt-oss-120b`, which is what Kaana's product default
 * resolves to, asking for the eight suggestions the app asks for: a complete
 * answer costs 1781–2454 output tokens, of which 940–2066 are REASONING. The
 * ceiling counts both, so the previous 2048 could not hold one — six of ten
 * sampled answers came back truncated mid-object with `finish_reason: length`,
 * one of them with the whole ceiling spent on reasoning and no answer at all.
 * At 4096 none of eight was truncated.
 */
const SUGGESTION_OUTPUT_TOKENS = 4096;

/**
 * How long the whole request may take, across every model call it makes.
 *
 * ONE deadline rather than one clock per call. The previous shape gave Kaana
 * thirty seconds and each of three fallback attempts thirty more, which is a
 * hundred and twenty seconds of work for a client (`use-suggestions.ts`) that
 * waits sixty — so the last two attempts were billed to answer nobody. It also
 * cancelled work that was going to succeed: the same measurement above took
 * 27.5–38.5 seconds wall-clock, so six of eight successful generations would
 * have been aborted at thirty.
 *
 * Fifty-five leaves the client's sixty with room for the inserts and the
 * response. A call that cannot start inside it is not started.
 */
const SUGGESTION_BUDGET_MS = 55_000;

const router = Router();

// ============== IN-MEMORY CACHE ==============

const cache = new Map<string, { data: any; expiresAt: number }>();
const CACHE_MAX_SIZE = 500;
/**
 * The instruction both inference paths send.
 *
 * One function rather than one literal per call site: while Kaana and the
 * in-process provider tree both exist, two copies of this prompt would drift,
 * and the drift would show as two surfaces answering differently for a reason
 * invisible in a diff.
 */
function suggestionPrompt(input: {
  count: number;
  profileParts: string;
  language: string;
  types: readonly string[];
}): string {
  const { count, profileParts, language, types } = input;
  return `Generate ${count} unique prompt suggestions as a JSON object.
User profile: ${profileParts}

Rules:
- Each suggestion MUST start with a different verb (Write, Help, Explain, Create, Plan, Summarize, Compare, etc.)
- Text must be a complete, ready-to-send prompt — NO placeholders like {username} or {variable}
- Vary categories: mix productivity, creative, coding, learning, communication
- Language: ${language} (all text in this language)
- Types needed: ${types.join(', ')}
  - "welcome": short title + description shown as cards (4-8 words title)
  - "autocomplete": longer text shown as user types (complete sentence)

Answer with an object whose "suggestions" key holds the ${count} items:
{"suggestions":[ … ]}

JSON schema per item:
{"title":"string","text":"string","description":"string","type":"welcome|autocomplete","category":"string","language":"${language}","triggerWords":["first 1-2 words of text"],"tags":["2-3"],"occupations":[],"interests":[]}

Examples:
- {"title":"Debug Code","text":"Help me debug this error and explain what went wrong","type":"autocomplete","category":"coding","language":"en-US","triggerWords":["help"],"tags":["coding","debug"],"occupations":[],"interests":[]}
- {"title":"Creative Writing","text":"Write a short story about an unexpected friendship","type":"welcome","category":"creative","language":"en-US","triggerWords":["write"],"tags":["writing","creative"],"occupations":[],"interests":[]}

Return ONLY that JSON object, no other text.`;
}

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
}, 2 * 60 * 1000).unref?.();

/**
 * POST /suggestions/list
 * List suggestions with filters. Language resolved server-side.
 * Body: { type?, category?, limit?, offset? }
 */
router.post('/list', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { type, category, limit = 200, offset = 0 } = req.body || {};
    const language = await getUserLanguage(req.user?.id);

    const suggestions = await listSuggestions(getDb(), {
      language,
      type: type === 'welcome' || type === 'autocomplete' ? type : undefined,
      category: typeof category === 'string' ? category : undefined,
      oxyUserId: req.user?.id,
      limit: Math.min(Number(limit) || 200, 500),
      offset: Number(offset) || 0,
    });

    res.json({ suggestions });
  } catch (error: unknown) {
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
    const requestedCount = Math.min(Number(count) || 4, 20);

    // Fetch a larger pool to randomly pick from
    let pool = await listWelcomePool(getDb(), language, req.user?.id, requestedCount * 5);

    // Fallback to en-US if no suggestions found for user's language
    if (pool.length === 0 && language !== 'en-US') {
      pool = await listWelcomePool(getDb(), 'en-US', req.user?.id, requestedCount * 5);
    }

    // If authenticated, try to personalize scoring
    if (req.user?.id && pool.length > 0) {
      try {
        const memory = await findUserMemory(getDb(), req.user.id);

        if (memory) {
          const userInterests = memory.preferences.interests;
          const userOccupation = memory.context.occupation || '';

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
  } catch (error: unknown) {
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
    const suggestions = await listOwnSuggestions(getDb(), req.user.id);
    res.json({ suggestions });
  } catch (error: unknown) {
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
    const suggestionId = `user-${title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 40)}-${Date.now().toString(36).slice(-4)}`;

    const suggestion = await createSuggestion(getDb(), {
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
      isAiGenerated: false,
      oxyUserId: req.user.id,
      ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
    });

    res.status(201).json({ suggestion });
  } catch (error: unknown) {
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

    // Both inputs reach the prompt, so both are bounded here rather than
    // trusted. `count` decides how much answer the output budget has to hold,
    // and `types` was reaching `Array.prototype.join` — a caller sending a
    // string for it turned this handler into a 500 before any model was asked.
    const requestedCount = Math.trunc(Number(req.body?.count) || 6);
    const count = Math.min(Math.max(requestedCount, 1), MAX_GENERATED_SUGGESTIONS);
    const requestedTypes: readonly string[] = Array.isArray(req.body?.types) ? req.body.types : [];
    const asked = SUGGESTION_TYPES.filter((known) => requestedTypes.includes(known));
    const types = asked.length > 0 ? asked : SUGGESTION_TYPES;

    // Fetch user context for personalization
    const memory = await findUserMemory(getDb(), req.user.id);

    const language = memory?.preferences.language || 'en-US';
    const interests = memory?.preferences.interests ?? [];
    const tone = memory?.preferences.tone || 'friendly';
    const occupation = memory?.context.occupation || '';
    const location = memory?.context.location || '';

    // Provider fallback retry loop
    const MAX_PROVIDER_RETRIES = 3;
    const skipProviders = new Set<string>();
    /**
     * The validated suggestions, once either path has produced them.
     *
     * One variable for two producers, because they now agree on a shape: both
     * are asked for {@link aiSuggestionListSchema} and neither hands this
     * handler anything it still has to parse. `null` means nobody has answered
     * yet.
     */
    let generated: AiSuggestion[] | null = null;
    /**
     * Kaana's answer, when Kaana served this call. Kept apart rather than
     * folded in: this one is still TEXT that has to be parsed, and the parse
     * failing is a different event from Kaana failing to answer — which is the
     * distinction the logs did not carry when this route was returning 500.
     */
    let kaanaText: string | null = null;
    /**
     * Whether a model answered and the answer could not be used.
     *
     * Separate from "no model answered", because the two are different things
     * to tell a caller and only one of them is worth retrying.
     */
    let unusableAnswer = false;

    /**
     * The deadline, shared by every model call this request makes.
     *
     * Created once, before the first of them, so the abort is against the
     * REQUEST's remaining time rather than each call's own fresh thirty
     * seconds. See {@link SUGGESTION_BUDGET_MS}.
     */
    const deadline = AbortSignal.timeout(SUGGESTION_BUDGET_MS);

    // Build compact user profile string (only non-empty fields)
    const profileParts = [
      `lang:${language}`,
      interests.length ? `interests:${interests.join(',')}` : '',
      occupation ? `job:${occupation}` : '',
      location ? `loc:${location}` : '',
      `tone:${tone}`,
    ].filter(Boolean).join(' | ');

    const prompt = suggestionPrompt({ count, profileParts, language, types });

    // Kaana first: it is the inference provider, and the loop below is what it
    // replaces. A failure here is not fatal while both paths exist.
    try {
      kaanaText = await generateTextViaKaana({
        prompt,
        // `authoring`: the surface vocabulary names what the work IS, and
        // writing prompt suggestions is authoring. There is no `suggestions`
        // member and inventing one would put a cost centre in the contract
        // that Oxy has never heard of.
        surface: 'authoring',
        maxOutputTokens: SUGGESTION_OUTPUT_TOKENS,
        temperature: 0.8,
        oxyUserId: req.user?.id ?? null,
        /**
         * The same schema the fallback asks for, converted once from the same
         * Zod object the answer is validated against — so the shape asked for
         * and the shape required cannot disagree. `await` because the SDK types
         * the conversion as possibly asynchronous; the cast because a JSON
         * Schema IS the JSON object the contract's field is typed as.
         */
        responseFormat: {
          type: 'json_schema',
          name: 'prompt_suggestions',
          schema: (await zodSchema(aiSuggestionListSchema).jsonSchema) as Record<string, unknown>,
          strict: false,
        },
        budgetMs: SUGGESTION_BUDGET_MS,
        signal: deadline,
      });
    } catch (err: unknown) {
      log.general.warn({ err }, 'Kaana did not serve the suggestion prompt, falling back');
    }

    if (kaanaText !== null) {
      /**
       * The whole answer, parsed as JSON — not a bracket-to-bracket slice of
       * it.
       *
       * What was here matched from the first `[` to the last `]` and parsed
       * that. On a truncated answer, which is what the model was actually
       * returning, the last `]` closes an item's `tags` array, so the slice is
       * a valid-looking prefix of a list and `JSON.parse` fails on it — the
       * regex found something every time and it was never the answer.
       */
      let answer: unknown = null;
      try {
        answer = JSON.parse(kaanaText);
      } catch {
        // Left as null so the schema below rejects it, rather than reporting a
        // syntax failure and a shape failure through two different paths.
        answer = null;
      }

      const parsed = aiSuggestionListSchema.safeParse(answer);
      if (!parsed.success) {
        /**
         * The thrown value is deliberately NOT logged.
         *
         * Both things it could be carry the model's whole answer — a Zod error
         * quotes what it was given, and the SDK's own parse failure keeps the
         * text on the error object — and pino's error serializer copies an
         * error's own properties into the line. That is the leak #182 removed
         * from this exact call site, and it would come back under a key this
         * package's content census does not read.
         *
         * `responseChars` is what identified the fault instead: a complete
         * answer for eight suggestions is around 3,400 characters, so a shorter
         * one that will not parse is an answer that was cut off.
         */
        log.general.error(
          { responseChars: kaanaText.length },
          'Failed to parse AI-generated suggestions',
        );
        return res.status(500).json({ error: 'Failed to generate suggestions' });
      }
      generated = parsed.data.suggestions;
    }

    for (let attempt = 0; generated === null && attempt < MAX_PROVIDER_RETRIES; attempt++) {
      const resolved = await resolveModel('alia-lite', skipProviders);
      if (!resolved) {
        if (attempt === 0) {
          return res.status(503).json({ error: 'No AI models available' });
        }
        break;
      }

      try {
        const model = getAIModel(resolved, 'background');
        /**
         * `generateObject`, as the planner and the verifier already ask for a
         * shape.
         *
         * It is the only call that sends the schema to the model at all — the
         * AI SDK carries a response format on this function and on no other —
         * and it parses and validates what comes back, so this handler never
         * holds an answer it still has to interpret.
         */
        const result = await generateObject({
          model,
          schema: aiSuggestionListSchema,
          abortSignal: deadline,
          prompt,
          maxOutputTokens: SUGGESTION_OUTPUT_TOKENS,
          temperature: 0.8,
          // The loop rotates providers itself, and every attempt spends the one
          // deadline above. An SDK-level retry would spend it twice on the same
          // provider before the rotation got a turn.
          maxRetries: 0,
        });
        generated = result.object.suggestions;
        break;
      } catch (providerError: unknown) {
        if (NoObjectGeneratedError.isInstance(providerError)) {
          /**
           * An unusable answer ends this attempt and nothing else.
           *
           * Deliberately not rethrown, even on the last attempt: the handler's
           * outer catch logs the thrown value under `err`, and this error
           * carries the model's whole answer on `text` — rethrowing it would
           * put the output into the logs by the back door, which is the leak
           * the branch below exists to avoid.
           */
          unusableAnswer = true;
          // Logged as what it is, and without the error object — `text` on it
          // is the model's whole answer, which pino's serializer would copy
          // into the line. `finishReason` is the fact that was missing while
          // this route was failing: `length` says the answer was cut off at the
          // output budget rather than malformed.
          log.general.error(
            {
              finishReason: providerError.finishReason ?? null,
              responseChars: providerError.text?.length ?? 0,
              provider: resolved.provider,
              attempt,
            },
            'Failed to parse AI-generated suggestions',
          );
        } else {
          log.general.error({ err: providerError, provider: resolved.provider, attempt }, 'Provider failed for suggestion generation');
          if (attempt >= MAX_PROVIDER_RETRIES - 1) throw providerError;
        }
        skipProviders.add(resolved.provider);
      }
    }

    if (generated === null) {
      // Two different answers, because the caller can act on one of them. No
      // model at all is a service that is down and worth retrying; a model that
      // answered with something unusable is not, and reporting it as capacity
      // would send a client into a retry loop against a model that will say the
      // same thing again.
      return unusableAnswer
        ? res.status(500).json({ error: 'Failed to generate suggestions' })
        : res.status(503).json({ error: 'No AI models available' });
    }

    // Create suggestion documents
    const created = [];
    for (let i = 0; i < generated.length; i++) {
      const item = generated[i];

      const slug = item.title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 40);
      const suggestionId = `ai-${slug}-${Date.now().toString(36).slice(-4)}-${i}`;

      try {
        const suggestion = await createSuggestion(getDb(), {
          suggestionId,
          title: item.title,
          text: item.text,
          description: item.description,
          type: item.type,
          category: item.category,
          triggerWords: item.triggerWords.slice(0, 5),
          tags: item.tags.slice(0, 5),
          occupations: item.occupations.slice(0, 5),
          interests: item.interests.slice(0, 5),
          scope: 'personal',
          language: item.language || language,
          isBuiltIn: false,
          isAiGenerated: true,
          oxyUserId: req.user!.id,
        });
        created.push(suggestion);
      } catch (err: unknown) {
        log.general.error({ err, suggestionId }, 'Failed to create AI suggestion');
      }
    }

    res.json({ suggestions: created, generated: created.length });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error generating suggestions');
    const errObj = error as { statusCode?: number; code?: string };
    const status = (errObj.statusCode ?? 0) >= 500 || errObj.code === 'ECONNREFUSED' ? 503 : 500;
    res.status(status).json({ error: 'Failed to generate suggestions' });
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

    const { id } = req.params;
    if (typeof id !== 'string') {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const existing = await findOwnSuggestion(getDb(), id, req.user.id);
    if (!existing) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    // The same allow-list as before, applied to a typed patch rather than by
    // `set()` on a document — mass assignment is not available either way, and
    // `text` is in it, which is why the repository re-derives the template
    // columns whenever it is supplied.
    const patch: SuggestionPatch = {
      ...(req.body.title === undefined ? {} : { title: req.body.title }),
      ...(req.body.text === undefined ? {} : { text: req.body.text }),
      ...(req.body.description === undefined ? {} : { description: req.body.description }),
      ...(req.body.type === 'welcome' || req.body.type === 'autocomplete'
        ? { type: req.body.type }
        : {}),
      ...(req.body.category === undefined ? {} : { category: req.body.category }),
      ...(req.body.triggerWords === undefined ? {} : { triggerWords: req.body.triggerWords }),
      ...(req.body.tags === undefined ? {} : { tags: req.body.tags }),
      ...(req.body.expiresAt === undefined
        ? {}
        : { expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null }),
    };

    const suggestion = await updateOwnSuggestion(getDb(), id, req.user.id, patch);
    if (!suggestion) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }
    res.json({ suggestion });
  } catch (error: unknown) {
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

    const { id } = req.params;
    if (typeof id !== 'string') {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    // `deletedCount === 0` becomes `rowCount === 0`. A DELETE either matched or
    // it did not, so there is no matched-versus-modified distinction here.
    const deleted = await deleteOwnSuggestion(getDb(), id, req.user.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    res.json({ success: true });
  } catch (error: unknown) {
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
    const limitNum = Math.min(Number(limit) || 6, 20);

    // 1. Global results — search all languages, cache by query+language (sort order depends on pref)
    const globalCacheKey = `search:${trimmed}:${language}`;
    let globalResults = cacheGet(globalCacheKey) as SuggestionSearchHit[] | null;
    if (!globalResults) {
      globalResults = await searchSuggestions(
        getDb(),
        trimmed,
        'global',
        undefined,
        limitNum * 2,
      );
      cacheSet(globalCacheKey, globalResults, SEARCH_CACHE_TTL);
    }

    // 2. Personal results — only for authenticated users, not cached
    let personalResults: SuggestionSearchHit[] = [];
    if (req.user?.id) {
      personalResults = await searchSuggestions(
        getDb(),
        trimmed,
        'personal',
        req.user.id,
        limitNum,
      );
    }

    // 3. Merge: personal first, then global, dedupe, prioritize user's language
    const seen = new Set<string>();
    const candidates: SuggestionSearchHit[] = [];
    for (const s of [...personalResults, ...globalResults]) {
      if (!seen.has(s.suggestionId)) {
        seen.add(s.suggestionId);
        candidates.push(s);
      }
    }
    // Sort: user's preferred language first, then others
    candidates.sort((a, b) => {
      const aMatch = a.language === language ? 0 : 1;
      const bMatch = b.language === language ? 0 : 1;
      return aMatch - bMatch;
    });
    const suggestions = candidates.slice(0, limitNum);

    res.json({ suggestions });
  } catch (error: unknown) {
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
    const { id } = req.params;
    if (typeof id !== 'string') {
      return res.status(400).json({ error: 'Failed to record usage' });
    }

    await incrementSuggestionUsage(getDb(), id);
    res.json({ success: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error recording suggestion usage');
    res.status(500).json({ error: 'Failed to record usage' });
  }
});

export default router;
