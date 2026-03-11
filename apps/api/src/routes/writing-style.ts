import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { getOrCreateUserMemory } from '../lib/memory/user-memory-service.js';
import { STYLE_LLM_REFINE_MIN_MESSAGES } from '../models/user-memory.js';
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

    // Only allow updating user-editable fields
    if (signOff !== undefined) memory.writingStyle.signOff = signOff;
    if (Array.isArray(greetingPatterns)) memory.writingStyle.greetingPatterns = greetingPatterns;
    if (Array.isArray(closingPatterns)) memory.writingStyle.closingPatterns = closingPatterns;
    if (Array.isArray(toneDescriptors)) memory.writingStyle.toneDescriptors = toneDescriptors;

    memory.markModified('writingStyle');
    await memory.save();

    const { _raw, ...publicProfile } = memory.writingStyle;
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
    memory.writingStyle = null;
    memory.markModified('writingStyle');
    await memory.save();

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
    Object.assign(memory.writingStyle, refinement);
    memory.writingStyle.lastLLMRefinedAt = new Date();

    memory.markModified('writingStyle');
    await memory.save();

    const { _raw, ...publicProfile } = memory.writingStyle;
    res.json({ writingStyle: publicProfile, message: 'Style profile refreshed with AI analysis' });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error refreshing writing style');
    res.status(500).json({ error: 'Failed to refresh writing style profile' });
  }
});

export default router;
