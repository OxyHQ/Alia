import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { getOrCreateUserMemory } from '../lib/memory/user-memory-service.js';
import { getDb } from '../db/index.js';
import { setWritingStyle } from '../db/memory/userMemoryRepository.js';
import { STYLE_LLM_REFINE_MIN_MESSAGES } from '../domain/writing-style.js';
import { log } from '../lib/logger.js';

const router = Router();

// All writing style routes require authentication
router.use(authenticateToken);

/**
 * GET /api/writing-style
 * Returns the user's writing style profile (or null if not yet analyzed)
 */
router.get('/', async (req, res) => {
  try {
    const memory = await getOrCreateUserMemory(req.user!.id);

    if (!memory.writingStyle) {
      res.json({ writingStyle: null });
      return;
    }

    // Return profile without _raw data (it's internal)
    const { _raw, ...publicProfile } = memory.writingStyle;
    res.json({ writingStyle: { ...publicProfile, messagesAnalyzed: _raw?.totalMessages || publicProfile.messagesAnalyzed } });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error fetching writing style');
    res.status(500).json({ error: 'Failed to fetch writing style profile' });
  }
});

/**
 * PUT /api/writing-style
 * Manual overrides for editable fields
 */
router.put('/', async (req, res) => {
  try {
    const { signOff, greetingPatterns, closingPatterns, toneDescriptors } = req.body;
    const memory = await getOrCreateUserMemory(req.user!.id);

    if (!memory.writingStyle) {
      res.status(400).json({ error: 'No writing style profile exists yet. Keep chatting to build one.' });
      return;
    }

    /**
     * Only user-editable fields. Written as a NEW object rather than mutated in
     * place: the column is `jsonb`, so the whole value is replaced on every
     * write and there is nothing corresponding to `markModified` — which existed
     * only because Mongoose could not see a mutation inside a `Mixed` path.
     */
    const next = {
      ...memory.writingStyle,
      ...(signOff !== undefined ? { signOff } : {}),
      ...(Array.isArray(greetingPatterns) ? { greetingPatterns } : {}),
      ...(Array.isArray(closingPatterns) ? { closingPatterns } : {}),
      ...(Array.isArray(toneDescriptors) ? { toneDescriptors } : {}),
    };

    await setWritingStyle(getDb(), memory._id, next);

    const { _raw, ...publicProfile } = next;
    res.json({ writingStyle: publicProfile });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error updating writing style');
    res.status(500).json({ error: 'Failed to update writing style profile' });
  }
});

/**
 * DELETE /api/writing-style
 * Reset the writing style profile entirely
 */
router.delete('/', async (req, res) => {
  try {
    const memory = await getOrCreateUserMemory(req.user!.id);
    await setWritingStyle(getDb(), memory._id, null);

    res.json({ success: true, message: 'Writing style profile reset' });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error resetting writing style');
    res.status(500).json({ error: 'Failed to reset writing style profile' });
  }
});

/**
 * POST /api/writing-style/refresh
 * Force an LLM refinement (if enough messages have been analyzed)
 */
router.post('/refresh', async (req, res) => {
  try {
    const memory = await getOrCreateUserMemory(req.user!.id);

    if (!memory.writingStyle) {
      res.status(400).json({ error: 'No writing style profile exists yet. Keep chatting to build one.' });
      return;
    }

    if (memory.writingStyle.messagesAnalyzed < STYLE_LLM_REFINE_MIN_MESSAGES) {
      res.status(400).json({
        error: `Need at least ${STYLE_LLM_REFINE_MIN_MESSAGES} messages for AI refinement. Currently: ${memory.writingStyle.messagesAnalyzed}.`,
      });
      return;
    }

    // Trigger LLM refinement
    const { refineStyleWithLLM } = await import('../lib/style/style-refiner.js');
    const refinement = await refineStyleWithLLM(req.user!.id, memory.writingStyle, []);
    const refined = { ...memory.writingStyle, ...refinement, lastLLMRefinedAt: new Date() };

    await setWritingStyle(getDb(), memory._id, refined);

    const { _raw, ...publicProfile } = refined;
    res.json({ writingStyle: publicProfile, message: 'Style profile refreshed with AI analysis' });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error refreshing writing style');
    res.status(500).json({ error: 'Failed to refresh writing style profile' });
  }
});

export default router;
