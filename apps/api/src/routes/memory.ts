import { Router } from 'express';
import { UserMemory } from '../models/user-memory.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();

// All memory routes require authentication
router.use(authenticateToken);

/**
 * GET /api/memory/stats
 * Get memory statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const memory = await UserMemory.findOne({ oxyUserId: req.user!.id });

    if (!memory) {
      res.json({
        totalMemories: 0,
        categories: {},
        hasPreferences: false,
        hasContext: false
      });
      return;
    }

    // Group memories by category
    const categories: Record<string, number> = {};
    memory.memories.forEach(m => {
      const cat = m.category || 'uncategorized';
      categories[cat] = (categories[cat] || 0) + 1;
    });

    res.json({
      totalMemories: memory.memories.length,
      categories,
      hasPreferences: Object.keys(memory.preferences || {}).length > 0,
      hasContext: Object.keys(memory.context || {}).length > 0
    });
  } catch (error) {
    console.error('Error fetching memory stats:', error);
    res.status(500).json({ error: 'Failed to fetch memory stats' });
  }
});

/**
 * GET /api/memory
 * Get user's memory profile
 */
router.get('/', async (req, res) => {
  try {
    let memory = await UserMemory.findOne({ oxyUserId: req.user!.id });

    // Create empty memory profile if doesn't exist
    if (!memory) {
      memory = new UserMemory({
        oxyUserId: req.user!.id,
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
    const memory = await UserMemory.findOneAndUpdate(
      { oxyUserId: req.user!.id },
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
    const memory = await UserMemory.findOneAndUpdate(
      { oxyUserId: req.user!.id },
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
 * Add a new memory or update if key exists
 */
router.post('/add', async (req, res) => {
  try {
    const { key, value, category } = req.body;

    if (!key || !value) {
      res.status(400).json({ error: 'Key and value are required' });
      return;
    }

    // Find existing memory
    let userMemory = await UserMemory.findOne({ oxyUserId: req.user!.id });

    if (!userMemory) {
      // Create new memory document
      userMemory = new UserMemory({
        oxyUserId: req.user!.id,
        memories: [{
          key,
          value,
          category,
          createdAt: new Date(),
          updatedAt: new Date()
        }],
        preferences: {},
        context: {}
      });
    } else {
      // Check if memory with this key exists
      const existingMemoryIndex = userMemory.memories.findIndex(m => m.key === key);

      if (existingMemoryIndex !== -1) {
        // Update existing memory
        userMemory.memories[existingMemoryIndex].value = value;
        if (category) userMemory.memories[existingMemoryIndex].category = category;
        userMemory.memories[existingMemoryIndex].updatedAt = new Date();
      } else {
        // Add new memory
        userMemory.memories.push({
          key,
          value,
          category,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }
    }

    await userMemory.save();
    res.json(userMemory);
  } catch (error) {
    console.error('Error adding memory:', error);
    res.status(500).json({ error: 'Failed to add memory' });
  }
});

/**
 * PUT /api/memory/:memoryId
 * Update a specific memory
 */
router.put('/:memoryId', async (req, res) => {
  try {
    const { key, value, category } = req.body;

    if (!key || !value) {
      res.status(400).json({ error: 'Key and value are required' });
      return;
    }

    const memory = await UserMemory.findOneAndUpdate(
      {
        oxyUserId: req.user!.id,
        'memories._id': req.params.memoryId
      },
      {
        $set: {
          'memories.$.key': key,
          'memories.$.value': value,
          'memories.$.category': category,
          'memories.$.updatedAt': new Date()
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
    console.error('Error updating memory:', error);
    res.status(500).json({ error: 'Failed to update memory' });
  }
});

/**
 * DELETE /api/memory/:memoryId
 * Delete a specific memory
 */
router.delete('/:memoryId', async (req, res) => {
  try {
    const memory = await UserMemory.findOneAndUpdate(
      { oxyUserId: req.user!.id },
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
