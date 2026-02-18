import { Router, Request, Response } from 'express';
import { generateText } from 'ai';
import { Skill } from '../models/skill.js';
import { authenticateToken } from '../middleware/auth.js';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../lib/chat-core.js';
import { log } from '../lib/logger.js';

const router = Router();

/**
 * GET /skills
 * List all available skills (excludes system prompts)
 * Supports optional ?language= and ?category= query filters
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { language, category } = req.query;
    const filter: any = {};

    if (language && typeof language === 'string') {
      filter.language = language;
    }
    if (category && typeof category === 'string' && category !== 'all') {
      filter.category = category;
    }

    const skills = await Skill.find(filter)
      .select('-systemPrompt')
      .sort({ category: 1, title: 1 })
      .lean();
    res.json({ skills });
  } catch (error: any) {
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
    const skills = await Skill.find({ oxyUserId: req.user.id })
      .select('-systemPrompt')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ skills });
  } catch (error: any) {
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

    const { prompt, language = 'en' } = req.body;
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
      } catch (providerError: any) {
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
      log.skills.error({ responseText }, 'Failed to parse AI-generated skill config');
      return res.status(500).json({ error: 'Failed to generate skill configuration' });
    }

    // Validate color is from palette
    const validColor = SKILL_COLORS.includes(parsed.color) ? parsed.color : SKILL_COLORS[0];

    res.json({
      title: parsed.title || 'New Skill',
      tagline: parsed.tagline || '',
      description: parsed.description || '',
      systemPrompt: parsed.systemPrompt || '',
      icon: parsed.icon || '🎯',
      color: validColor,
      category: ['featured', 'community', 'recent'].includes(parsed.category) ? parsed.category : 'community',
      language,
      triggers: Array.isArray(parsed.triggers) ? parsed.triggers.slice(0, 10) : [],
      includes: Array.isArray(parsed.includes) ? parsed.includes.slice(0, 10) : [],
      useCase: parsed.useCase || '',
      goodAt: Array.isArray(parsed.goodAt) ? parsed.goodAt.slice(0, 10) : [],
      notGoodAt: Array.isArray(parsed.notGoodAt) ? parsed.notGoodAt.slice(0, 10) : [],
    });
  } catch (error) {
    log.skills.error({ err: error }, 'Error generating skill config');
    res.status(500).json({ error: 'Failed to generate skill configuration' });
  }
});

/**
 * GET /skills/:skillId
 * Get a single skill by ID (excludes system prompt)
 */
router.get('/:skillId', async (req: Request, res: Response) => {
  try {
    const skill = await Skill.findOne({ skillId: req.params.skillId })
      .select('-systemPrompt')
      .lean();
    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' });
    }
    res.json({ skill });
  } catch (error: any) {
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
    const skill = await Skill.findOne({ skillId: req.params.skillId })
      .select('skillId title systemPrompt')
      .lean();
    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' });
    }
    res.json({ skillId: skill.skillId, title: skill.title, systemPrompt: skill.systemPrompt });
  } catch (error: any) {
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

    const {
      title, tagline, description, systemPrompt,
      author, icon, color, category, language,
      triggers, includes, useCase, goodAt, notGoodAt,
    } = req.body;

    if (!title || !tagline || !description || !systemPrompt || !icon || !color || !category) {
      return res.status(400).json({
        error: 'title, tagline, description, systemPrompt, icon, color, and category are required',
      });
    }

    // Generate skillId from title (kebab-case, unique)
    let skillId = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');

    const existing = await Skill.findOne({ skillId });
    if (existing) {
      skillId = `${skillId}-${Date.now().toString(36).slice(-4)}`;
    }

    const skill = await Skill.create({
      skillId,
      title,
      tagline,
      description,
      systemPrompt,
      author: author || req.user.username || 'Unknown',
      icon,
      color,
      category,
      language: language || 'en',
      triggers: triggers || [],
      includes: includes || [],
      useCase: useCase || '',
      goodAt: goodAt || [],
      notGoodAt: notGoodAt || [],
      isBuiltIn: false,
      oxyUserId: req.user.id,
    });

    // Return without systemPrompt
    const result = skill.toObject();
    delete (result as any).systemPrompt;
    res.status(201).json({ skill: result });
  } catch (error: any) {
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

    const skill = await Skill.findOne({
      skillId: req.params.skillId,
      oxyUserId: req.user.id,
      isBuiltIn: false,
    });

    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' });
    }

    const allowedFields = [
      'title', 'tagline', 'description', 'systemPrompt',
      'icon', 'color', 'category', 'language',
      'triggers', 'includes', 'useCase', 'goodAt', 'notGoodAt',
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        (skill as any)[field] = req.body[field];
      }
    }

    await skill.save();

    // Return without systemPrompt
    const result = skill.toObject();
    delete (result as any).systemPrompt;
    res.json({ skill: result });
  } catch (error: any) {
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

    const result = await Skill.deleteOne({
      skillId: req.params.skillId,
      oxyUserId: req.user.id,
      isBuiltIn: false,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Skill not found' });
    }

    res.json({ success: true });
  } catch (error: any) {
    log.skills.error({ err: error }, 'Error deleting skill');
    res.status(500).json({ error: 'Failed to delete skill' });
  }
});

export default router;
