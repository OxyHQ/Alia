import { Router, Request, Response } from 'express';
import { generateText } from 'ai';
import { getDb } from '../db/index.js';
import {
  createSkill,
  deleteOwnedSkill,
  findPublicSkill,
  findSkillPrompt,
  listOwnedSkills,
  listSkillCatalogue,
  skillIdExists,
  updateOwnedSkill,
  type SkillPatch,
} from '../db/agents/skillRepository.js';
import { SKILL_CATEGORIES, type SkillCategory } from '../domain/skill.js';
import { authenticateToken, optionalAuth, oxyClient } from '../middleware/auth.js';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../lib/chat-core.js';
import { log } from '../lib/logger.js';

const router = Router();

/**
 * The three readers every write path in this file goes through.
 *
 * `req.body` is `any`, so a value copied out of it satisfies any parameter type
 * `tsc` is asked to check it against. Mongoose used to catch that at the schema
 * — a number assigned to a `String` path was cast, an object was rejected — and
 * a `text` column catches none of it. These are where the shape is established.
 */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * A `text[]` column's contents, capped at ten as the generator route already
 * caps its own output.
 *
 * Anything that is not an array of strings becomes an EMPTY array rather than an
 * error, which is what `triggers || []` did for a missing value; the difference
 * is that a malformed one no longer travels. Non-string elements are dropped
 * individually, so one bad entry does not discard the rest.
 */
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').slice(0, 10);
}

function isSkillCategory(value: unknown): value is SkillCategory {
  return typeof value === 'string' && (SKILL_CATEGORIES as readonly string[]).includes(value);
}

/**
 * GET /skills
 * List all available skills (excludes system prompts)
 * Supports optional ?language= and ?category= query filters
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { language, category } = req.query;

    const skills = await listSkillCatalogue(getDb(), {
      ...(typeof language === 'string' && language ? { language } : {}),
      ...(typeof category === 'string' && category && category !== 'all' ? { category } : {}),
    });
    res.json({ skills });
  } catch (error: unknown) {
    log.skills.error({ err: error }, 'Error listing skills');
    res.status(500).json({ error: 'Failed to list skills' });
  }
});

/**
 * GET /skills/me
 * List current user's own skills (authenticated)
 */
router.get('/me', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const skills = await listOwnedSkills(getDb(), req.user.id);
    res.json({ skills });
  } catch (error: unknown) {
    log.skills.error({ err: error }, 'Error listing user skills');
    res.status(500).json({ error: 'Failed to list your skills' });
  }
});

/**
 * POST /skills/generate
 * AI generates a skill config from a natural language prompt (authenticated)
 */
router.post('/generate', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { prompt, language = 'en-US' } = req.body;
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
      return res.status(400).json({ error: 'A prompt of at least 10 characters is required' });
    }

    const SKILL_COLORS = [
      '#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6',
      '#ef4444', '#3b82f6', '#a855f7', '#0ea5e9', '#84cc16',
      '#06b6d4', '#22c55e', '#f97316', '#dc2626', '#e11d48',
    ];

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
              content: `You are a skill configuration generator. Given a user's description of what they want their AI skill to do, generate a structured JSON configuration for the skill.

A "skill" is a modular instruction set that turns an AI assistant into a domain specialist. It contains a system prompt and metadata describing when and how to use it.

Return ONLY valid JSON with these fields:
- "title": A short, memorable name for the skill (2-5 words max)
- "tagline": A one-sentence description (under 100 chars)
- "description": A detailed description of the skill's purpose and behavior (2-3 sentences)
- "systemPrompt": Comprehensive instructions for the AI when this skill is active. Include role definition, behavior guidelines, output format preferences, and domain-specific rules. This should be thorough and specific (at least 200 words).
- "icon": A single emoji that best represents this skill
- "color": Pick one hex color from this palette: ${SKILL_COLORS.join(', ')}
- "category": Exactly one of: "community", "recent"
- "triggers": An array of 3-5 example phrases that would activate this skill (e.g., "review my code", "translate this text")
- "includes": An array of 2-4 things this skill includes (e.g., "Security checklist", "Style guide compliance")
- "useCase": A one-sentence description of when to use this skill
- "goodAt": An array of 3-5 things this skill is good at
- "notGoodAt": An array of 2-3 things this skill is NOT good at (limitations)

The language for all text content should be: ${language}

Do not include any text outside the JSON object.`,
            },
            {
              role: 'user',
              content: prompt.trim(),
            },
          ],
          temperature: 0.7,
          maxRetries: 0,
        });
        break;
      } catch (providerError: unknown) {
        log.skills.error({ err: providerError, provider: resolved.provider, attempt }, 'Provider failed for skill generation');
        skipProviders.add(resolved.provider);
        if (attempt >= MAX_PROVIDER_RETRIES - 1) throw providerError;
      }
    }

    if (!result) {
      return res.status(503).json({ error: 'No AI models available' });
    }

    const responseText = result.text || '';

    // Parse JSON from response (handle potential markdown code blocks)
    let parsed: any;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      log.skills.error({ responseChars: responseText.length }, 'Failed to parse AI-generated skill config');
      return res.status(500).json({ error: 'Failed to generate skill configuration' });
    }

    // Validate color is from palette
    const validColor = SKILL_COLORS.includes(parsed.color) ? parsed.color : SKILL_COLORS[0];

    // Resolve author name from Oxy user profile
    let authorName = req.user.username || '';
    if (!authorName) {
      try {
        const oxyUser = await oxyClient.getUserById(req.user.id);
        authorName = oxyUser?.username || oxyUser?.name?.first || 'Unknown';
      } catch {
        authorName = 'Unknown';
      }
    }

    res.json({
      title: parsed.title || 'New Skill',
      tagline: parsed.tagline || '',
      description: parsed.description || '',
      systemPrompt: parsed.systemPrompt || '',
      icon: parsed.icon || '🎯',
      color: validColor,
      category: ['featured', 'community', 'recent'].includes(parsed.category) ? parsed.category : 'community',
      language,
      author: authorName,
      triggers: Array.isArray(parsed.triggers) ? parsed.triggers.slice(0, 10) : [],
      includes: Array.isArray(parsed.includes) ? parsed.includes.slice(0, 10) : [],
      useCase: parsed.useCase || '',
      goodAt: Array.isArray(parsed.goodAt) ? parsed.goodAt.slice(0, 10) : [],
      notGoodAt: Array.isArray(parsed.notGoodAt) ? parsed.notGoodAt.slice(0, 10) : [],
    });
  } catch (error: unknown) {
    log.skills.error({ err: error }, 'Error generating skill config');
    res.status(500).json({ error: 'Failed to generate skill configuration' });
  }
});

/**
 * GET /skills/:skillId
 * Get a single skill by ID (excludes system prompt)
 * Unpublished non-built-in skills are only visible to their owner
 */
router.get('/:skillId', optionalAuth, async (req: Request, res: Response) => {
  try {
    const skill = await findPublicSkill(getDb(), String(req.params.skillId));
    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' });
    }
    // Unpublished user-created skills are only visible to their owner
    if (!skill.isPublished && !skill.isBuiltIn) {
      if (!req.user?.id || skill.oxyUserId !== req.user.id) {
        return res.status(404).json({ error: 'Skill not found' });
      }
    }
    res.json({ skill });
  } catch (error: unknown) {
    log.skills.error({ err: error }, 'Error getting skill');
    res.status(500).json({ error: 'Failed to get skill' });
  }
});

/**
 * GET /skills/:skillId/prompt
 * Get the system prompt for a skill (authenticated, used by chat pipeline)
 */
router.get('/:skillId/prompt', authenticateToken, async (req: Request, res: Response) => {
  try {
    const skill = await findSkillPrompt(getDb(), String(req.params.skillId));
    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' });
    }
    res.json({ skillId: skill.skillId, title: skill.title, systemPrompt: skill.systemPrompt });
  } catch (error: unknown) {
    log.skills.error({ err: error }, 'Error getting skill prompt');
    res.status(500).json({ error: 'Failed to get skill prompt' });
  }
});

/**
 * POST /skills
 * Create a new skill (authenticated)
 */
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const body: Record<string, unknown> = req.body;
    const title = readString(body.title);
    const tagline = readString(body.tagline);
    const description = readString(body.description);
    const systemPrompt = readString(body.systemPrompt);
    const icon = readString(body.icon);
    const color = readString(body.color);
    const category = body.category;

    if (!title || !tagline || !description || !systemPrompt || !icon || !color || !category) {
      return res.status(400).json({
        error: 'title, tagline, description, systemPrompt, icon, color, and category are required',
      });
    }

    if (!isSkillCategory(category)) {
      return res.status(400).json({
        error: `category must be one of: ${SKILL_CATEGORIES.join(', ')}`,
      });
    }

    // Resolve author name
    let authorName = readString(body.author) || req.user.username;
    if (!authorName) {
      try {
        const oxyUser = await oxyClient.getUserById(req.user.id);
        authorName = oxyUser?.username || oxyUser?.name?.first || 'Unknown';
      } catch {
        authorName = 'Unknown';
      }
    }

    // Generate skillId from title (kebab-case, unique)
    let skillId = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');

    if (await skillIdExists(getDb(), skillId)) {
      skillId = `${skillId}-${Date.now().toString(36).slice(-4)}`;
    }

    const skill = await createSkill(getDb(), {
      skillId,
      title,
      tagline,
      description,
      systemPrompt,
      author: authorName,
      icon,
      color,
      category,
      language: readString(body.language) || 'en-US',
      triggers: readStringArray(body.triggers),
      includes: readStringArray(body.includes),
      useCase: readString(body.useCase) ?? '',
      goodAt: readStringArray(body.goodAt),
      notGoodAt: readStringArray(body.notGoodAt),
      oxyUserId: req.user.id,
    });

    res.status(201).json({ skill });
  } catch (error: unknown) {
    log.skills.error({ err: error }, 'Error creating skill');
    res.status(500).json({ error: 'Failed to create skill' });
  }
});

/**
 * PATCH /skills/:skillId
 * Update a skill (authenticated, owner only, non-built-in only)
 */
router.patch('/:skillId', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const body: Record<string, unknown> = req.body;

    let category: SkillCategory | undefined;
    if (body.category !== undefined) {
      if (!isSkillCategory(body.category)) {
        return res.status(400).json({
          error: `category must be one of: ${SKILL_CATEGORIES.join(', ')}`,
        });
      }
      category = body.category;
    }

    /**
     * The whitelist, one key at a time.
     *
     * Every value is read through a type guard rather than copied off the body,
     * so a client sending `triggers: "rm -rf"` has it ignored instead of reaching
     * a `text[]` column. The Mongoose version assigned `req.body[field]` and
     * leaned on schema casting for that, which is the protection a port loses
     * first — `text[]` casts nothing, and `req.body` is `any`, so an unguarded
     * copy would have type-checked.
     *
     * A key absent from the body is absent from the patch. `$set: { x: undefined }`
     * is a no-op in Mongo and the same key in Postgres writes NULL, so "leave it
     * alone" has to be expressed by OMISSION, and the repository refuses an
     * entirely empty patch rather than emitting `SET` with no assignments.
     */
    const title = readString(body.title);
    const tagline = readString(body.tagline);
    const description = readString(body.description);
    const systemPrompt = readString(body.systemPrompt);
    const icon = readString(body.icon);
    const color = readString(body.color);
    const language = readString(body.language);
    const useCase = readString(body.useCase);

    const patch: SkillPatch = {
      ...(title === undefined ? {} : { title }),
      ...(tagline === undefined ? {} : { tagline }),
      ...(description === undefined ? {} : { description }),
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      ...(icon === undefined ? {} : { icon }),
      ...(color === undefined ? {} : { color }),
      ...(category === undefined ? {} : { category }),
      ...(language === undefined ? {} : { language }),
      ...(body.triggers === undefined ? {} : { triggers: readStringArray(body.triggers) }),
      ...(body.includes === undefined ? {} : { includes: readStringArray(body.includes) }),
      ...(useCase === undefined ? {} : { useCase }),
      ...(body.goodAt === undefined ? {} : { goodAt: readStringArray(body.goodAt) }),
      ...(body.notGoodAt === undefined ? {} : { notGoodAt: readStringArray(body.notGoodAt) }),
      ...(typeof body.isPublished === 'boolean' ? { isPublished: body.isPublished } : {}),
    };

    const skill = await updateOwnedSkill(getDb(), String(req.params.skillId), req.user.id, patch);

    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' });
    }

    res.json({ skill });
  } catch (error: unknown) {
    log.skills.error({ err: error }, 'Error updating skill');
    res.status(500).json({ error: 'Failed to update skill' });
  }
});

/**
 * DELETE /skills/:skillId
 * Delete a skill (authenticated, owner only, non-built-in only)
 */
router.delete('/:skillId', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const deleted = await deleteOwnedSkill(getDb(), String(req.params.skillId), req.user.id);

    if (deleted === 0) {
      return res.status(404).json({ error: 'Skill not found' });
    }

    res.json({ success: true });
  } catch (error: unknown) {
    log.skills.error({ err: error }, 'Error deleting skill');
    res.status(500).json({ error: 'Failed to delete skill' });
  }
});

export default router;
