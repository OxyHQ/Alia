import { Router, Request, Response } from 'express';
import { Skill } from '../models/skill.js';
import { authenticateToken } from '../middleware/auth.js';
import { log } from '../lib/logger.js';

const router = Router();

/**
 * GET /skills
 * List all available skills (excludes system prompts)
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const skills = await Skill.find()
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

export default router;
