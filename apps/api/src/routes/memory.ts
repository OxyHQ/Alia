import { Router } from 'express';
import { UserMemory } from '../models/user-memory.js';
import { User } from '../models/user.js';
import { authenticateToken } from '../middleware/auth.js';
import { z } from 'zod';

const router = Router();

// All memory routes require authentication
router.use(authenticateToken);

/**
 * GET /api/memory
 * Get user's memory profile
 */
router.get('/', async (req, res) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    let memory = await UserMemory.findOne({ userId: req.user.id });

    // Create empty memory profile if doesn't exist
    if (!memory) {
      memory = new UserMemory({
        userId: req.user.id,
        memories: [],
        preferences: {},
        context: {}
      });
      await memory.save();
    }

    res.json(memory);
  } catch (error) {
    console.error('Error fetching memory:', error);
    res.status(500).json({ error: 'Failed to fetch memory' });
  }
});

/**
 * PUT /api/memory/context
 * Update user context (occupation, location, bio, etc.)
 */
router.put('/context', async (req, res) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const memory = await UserMemory.findOneAndUpdate(
      { userId: req.user.id },
      {
        $set: {
          context: req.body,
          updatedAt: new Date()
        }
      },
      { upsert: true, new: true }
    );

    res.json(memory);
  } catch (error) {
    console.error('Error updating context:', error);
    res.status(500).json({ error: 'Failed to update context' });
  }
});

/**
 * PUT /api/memory/preferences
 * Update user preferences (language, tone, interests, etc.)
 */
router.put('/preferences', async (req, res) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const memory = await UserMemory.findOneAndUpdate(
      { userId: req.user.id },
      {
        $set: {
          preferences: req.body,
          updatedAt: new Date()
        }
      },
      { upsert: true, new: true }
    );

    res.json(memory);
  } catch (error) {
    console.error('Error updating preferences:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

/**
 * POST /api/memory/add
 * Add a new memory
 */
router.post('/add', async (req, res) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { key, value, category } = req.body;

    if (!key || !value) {
      res.status(400).json({ error: 'Key and value are required' });
      return;
    }

    const memory = await UserMemory.findOneAndUpdate(
      { userId: req.user.id },
      {
        $push: {
          memories: {
            key,
            value,
            category,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        }
      },
      { upsert: true, new: true }
    );

    res.json(memory);
  } catch (error) {
    console.error('Error adding memory:', error);
    res.status(500).json({ error: 'Failed to add memory' });
  }
});

/**
 * DELETE /api/memory/:memoryId
 * Delete a specific memory
 */
router.delete('/:memoryId', async (req, res) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const memory = await UserMemory.findOneAndUpdate(
      { userId: req.user.id },
      {
        $pull: {
          memories: { _id: req.params.memoryId }
        }
      },
      { new: true }
    );

    if (!memory) {
      res.status(404).json({ error: 'Memory not found' });
      return;
    }

    res.json(memory);
  } catch (error) {
    console.error('Error deleting memory:', error);
    res.status(500).json({ error: 'Failed to delete memory' });
  }
});

export default router;
