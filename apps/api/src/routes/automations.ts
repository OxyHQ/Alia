import { Router } from 'express';
import { generateText } from 'ai';
import { Automation } from '../models/automation.js';
import { authenticateToken } from '../middleware/auth.js';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../lib/chat-core.js';
import { reloadAutomation } from '../lib/automation-scheduler.js';
import { log } from '../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

// All routes require authentication
router.use(authenticateToken);

// GET /automations - list user's automations
router.get('/', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const automations = await Automation.find({ oxyUserId: req.user.id })
      .sort({ createdAt: -1 });

    res.json({ automations });
  } catch (error) {
    log.automations.error({ err: error }, 'Error listing automations');
    res.status(500).json({ error: 'Failed to list automations' });
  }
});

// POST /automations - create automation
router.post('/', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { name, prompt, roleId, schedule } = req.body;

    // Validate required fields
    if (!name || !prompt || !schedule) {
      return res.status(400).json({ error: 'name, prompt, and schedule are required' });
    }

    if (!schedule.type || !['daily', 'interval'].includes(schedule.type)) {
      return res.status(400).json({ error: 'schedule.type must be "daily" or "interval"' });
    }

    if (schedule.type === 'interval' && (!schedule.intervalMinutes || schedule.intervalMinutes < 1)) {
      return res.status(400).json({ error: 'schedule.intervalMinutes is required for interval type and must be >= 1' });
    }

    if (schedule.type === 'daily') {
      if (schedule.time && !/^\d{2}:\d{2}$/.test(schedule.time)) {
        return res.status(400).json({ error: 'schedule.time must be in HH:MM format' });
      }
      const validDays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      if (schedule.days && !schedule.days.every((d: string) => validDays.includes(d))) {
        return res.status(400).json({ error: 'schedule.days must contain valid day names' });
      }
    }

    const automation = await Automation.create({
      oxyUserId: req.user.id,
      name,
      prompt,
      roleId,
      schedule,
      enabled: true,
    });

    // Reload scheduler for this automation
    reloadAutomation(automation._id.toString()).catch((err) =>
      log.automations.error({ err }, 'Failed to reload scheduler')
    );

    res.status(201).json({ automation });
  } catch (error) {
    log.automations.error({ err: error }, 'Error creating automation');
    res.status(500).json({ error: 'Failed to create automation' });
  }
});

// PATCH /automations/:id - update automation
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { name, prompt, roleId, schedule, enabled } = req.body;

    const automation = await Automation.findOne({
      _id: req.params.id,
      oxyUserId: req.user.id,
    });

    if (!automation) {
      return res.status(404).json({ error: 'Automation not found' });
    }

    // Update only provided fields
    if (name !== undefined) automation.name = name;
    if (prompt !== undefined) automation.prompt = prompt;
    if (roleId !== undefined) automation.roleId = roleId;
    if (schedule !== undefined) automation.schedule = schedule;
    if (enabled !== undefined) automation.enabled = enabled;

    await automation.save();

    // Reload scheduler for this automation
    reloadAutomation(automation._id.toString()).catch((err) =>
      log.automations.error({ err }, 'Failed to reload scheduler')
    );

    res.json({ automation });
  } catch (error) {
    log.automations.error({ err: error }, 'Error updating automation');
    res.status(500).json({ error: 'Failed to update automation' });
  }
});

// DELETE /automations/:id - delete automation
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await Automation.deleteOne({
      _id: req.params.id,
      oxyUserId: req.user.id,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Automation not found' });
    }

    // Remove from scheduler
    reloadAutomation(String(req.params.id)).catch((err) =>
      log.automations.error({ err }, 'Failed to reload scheduler')
    );

    res.json({ success: true });
  } catch (error) {
    log.automations.error({ err: error }, 'Error deleting automation');
    res.status(500).json({ error: 'Failed to delete automation' });
  }
});

// POST /automations/:id/run - manual trigger
router.post('/:id/run', async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const automation = await Automation.findOne({
      _id: req.params.id,
      oxyUserId: req.user.id,
    });

    if (!automation) {
      return res.status(404).json({ error: 'Automation not found' });
    }

    // Mark as running
    automation.lastRunStatus = 'running';
    await automation.save();

    try {
      // Resolve AI model
      const resolved = await resolveModel(getDefaultAliaModel());
      if (!resolved) {
        automation.lastRunStatus = 'failed';
        automation.lastRunResult = 'No AI models available';
        await automation.save();
        return res.status(503).json({ error: 'No AI models available' });
      }

      const model = getAIModel(resolved.keyConfig);

      // Run the prompt through generateText (non-streaming for automation)
      const result = await generateText({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are Alia, an AI assistant running an automated task. Be concise and actionable in your response.',
          },
          {
            role: 'user',
            content: automation.prompt,
          },
        ],
        temperature: 0.3,
        maxRetries: 0,
      });

      const resultText = result.text || 'No response generated';

      // Update automation with result
      automation.lastRunAt = new Date();
      automation.runCount += 1;
      automation.lastRunResult = resultText;
      automation.lastRunStatus = 'success';
      await automation.save();

      res.json({
        success: true,
        result: resultText,
        automation,
      });
    } catch (aiError: any) {
      log.automations.error({ err: aiError }, 'AI execution error');

      automation.lastRunStatus = 'failed';
      automation.lastRunResult = aiError.message || 'AI execution failed';
      await automation.save();

      res.status(500).json({
        error: 'Automation execution failed',
        details: aiError.message,
      });
    }
  } catch (error) {
    log.automations.error({ err: error }, 'Error running automation');
    res.status(500).json({ error: 'Failed to run automation' });
  }
});

export default router;
