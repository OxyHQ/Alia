import { Router } from 'express';
import { getDb } from '../db/index.js';
import {
  findUserMemory,
  replacePreferences,
  updateSettings,
} from '../db/memory/userMemoryRepository.js';
import { authenticateToken } from '../middleware/auth.js';
import { MemorySettingsSchema } from '../lib/validators/memory-validators.js';
import { getOrCreateUserMemory } from '../lib/memory/user-memory-service.js';
import { log } from '../lib/logger.js';

/**
 * What Alia keeps about a person is settings and a learned writing style. Her memory of the
 * person (facts, preferences as free text, context) lives in Nilo's `memories` database and is
 * reached through the `oxy_nilo_memories__*` tools (`docs/memory-system.md`), so there is no
 * route here to add, edit, search, import or export memories.
 */
const router = Router();

// All memory routes require authentication
router.use(authenticateToken);

/**
 * GET /api/memory
 * The person's Alia settings: language, tone, response length, and the "Use in AI responses" toggle.
 */
router.get('/', async (req, res) => {
  try {
    res.json(await getOrCreateUserMemory(req.user!.id));
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error fetching memory');
    res.status(500).json({ error: 'Failed to fetch memory' });
  }
});

/**
 * PUT /api/memory/preferences
 * Update the preferences Alia answers by (language, tone, response length).
 */
router.put('/preferences', async (req, res) => {
  try {
    // Named, not spread: `req.body` cannot become mass assignment.
    const userId = req.user!.id;
    const { language, tone, responseLength } = req.body ?? {};
    const profile = await getOrCreateUserMemory(userId);
    await replacePreferences(getDb(), profile._id, { language, tone, responseLength });

    res.json(await findUserMemory(getDb(), userId));
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error updating preferences');
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

/**
 * PUT /api/memory/settings
 * Update the "Use in AI responses" toggle.
 */
router.put('/settings', async (req, res) => {
  try {
    const validation = MemorySettingsSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: 'Invalid settings data',
        details: validation.error.issues,
      });
      return;
    }

    const userId = req.user!.id;
    const memory = await getOrCreateUserMemory(userId);

    await updateSettings(getDb(), memory._id, {
      autoSaveEnabled: validation.data.autoSaveEnabled,
      recallEnabled: validation.data.recallEnabled,
    });

    const updated = await findUserMemory(getDb(), userId);
    res.json(updated?.settings ?? memory.settings);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error updating memory settings');
    res.status(500).json({ error: 'Failed to update memory settings' });
  }
});

export default router;
