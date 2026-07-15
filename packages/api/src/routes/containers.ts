/**
 * Container Routes — Admin/debug endpoints for managing containers.
 *
 * These are NOT used by agents (agents use tools via agent-tools.ts).
 * These endpoints are for users to view/manage their containers.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { Container } from '../models/container.js';
import { ContainerTemplate } from '../models/container-template.js';
import * as containerManager from '../lib/container-manager.js';
import { log } from '../lib/logger.js';

const router = Router();

// All routes require authentication
router.use(authenticateToken);

// ── List user's containers ──

router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const containers = await Container.find({
      userId,
      status: { $ne: 'destroyed' },
    }).sort({ createdAt: -1 }).lean();

    res.json({ containers });
  } catch (err: unknown) {
    log.general.error({ err }, 'Failed to list containers');
    res.status(500).json({ error: 'Failed to list containers' });
  }
});

// ── Get container details ──

router.get('/:id', async (req, res) => {
  try {
    const userId = req.user?.id;
    const container = await Container.findOne({
      containerId: req.params.id,
      userId,
    }).lean();

    if (!container) {
      res.status(404).json({ error: 'Container not found' });
      return;
    }

    res.json({ container });
  } catch (err: unknown) {
    log.general.error({ err }, 'Failed to get container');
    res.status(500).json({ error: 'Failed to get container' });
  }
});

// ── Force destroy a container ──

router.delete('/:id', async (req, res) => {
  try {
    const userId = req.user?.id;
    const container = await Container.findOne({
      containerId: req.params.id,
      userId,
    });

    if (!container) {
      res.status(404).json({ error: 'Container not found' });
      return;
    }

    if (container.status !== 'destroyed') {
      await containerManager.destroyContainer(container.containerId);
      container.status = 'destroyed';
      container.destroyedAt = new Date();
      await container.save();
    }

    res.json({ destroyed: true });
  } catch (err: unknown) {
    log.general.error({ err }, 'Failed to destroy container');
    res.status(500).json({ error: 'Failed to destroy container' });
  }
});

// ── List user's templates ──

router.get('/templates/list', async (req, res) => {
  try {
    const userId = req.user?.id;
    const templates = await ContainerTemplate.find({ userId }).sort({ createdAt: -1 }).lean();
    res.json({ templates });
  } catch (err: unknown) {
    log.general.error({ err }, 'Failed to list templates');
    res.status(500).json({ error: 'Failed to list templates' });
  }
});

// ── Delete a template ──

router.delete('/templates/:id', async (req, res) => {
  try {
    const userId = req.user?.id;
    const template = await ContainerTemplate.findOneAndDelete({
      _id: req.params.id,
      userId,
    });

    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    res.json({ deleted: true });
  } catch (err: unknown) {
    log.general.error({ err }, 'Failed to delete template');
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

export default router;
