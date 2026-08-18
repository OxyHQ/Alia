/**
 * Container Routes — Admin/debug endpoints for managing containers.
 *
 * These are NOT used by agents (agents use tools via agent-tools.ts).
 * These endpoints are for users to view/manage their containers.
 *
 * Every handler refuses a request without `req.user.id`, which three of them did
 * not before. `authenticateToken` is mounted on the router so the guard never
 * fires — but the Mongoose filters read `{ userId }` and Mongo DROPS an
 * `undefined` key, so an unauthenticated request reaching any of them would have
 * matched EVERY account's container rather than none. The repository takes a
 * `string`, so that shape is now unrepresentable.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import {
  deleteOwnedContainerTemplate,
  findOwnedContainer,
  listOwnedContainerTemplates,
  listOwnedContainers,
  markContainerDestroyed,
} from '../db/agents/containerRepository.js';
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

    const containers = await listOwnedContainers(getDb(), userId);

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
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const container = await findOwnedContainer(getDb(), req.params.id, userId);

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
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const container = await findOwnedContainer(getDb(), req.params.id, userId);

    if (!container) {
      res.status(404).json({ error: 'Container not found' });
      return;
    }

    if (container.status !== 'destroyed') {
      await containerManager.destroyContainer(container.containerId);
      await markContainerDestroyed(getDb(), container.containerId, userId);
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
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const templates = await listOwnedContainerTemplates(getDb(), userId);
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
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const deleted = await deleteOwnedContainerTemplate(getDb(), req.params.id, userId);

    if (deleted === 0) {
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
