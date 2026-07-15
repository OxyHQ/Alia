import { Router } from 'express';
import { UserMemory, getMemoryLimit } from '../models/user-memory.js';
import { Subscription } from '../models/subscription.js';
import { authenticateToken } from '../middleware/auth.js';
import {
  AddMemorySchema,
  ImportMemorySchema,
  MergeStrategySchema,
  MemorySettingsSchema,
} from '../lib/validators/memory-validators.js';
import { getOrCreateUserMemory } from '../lib/memory/user-memory-service.js';
import { log } from '../lib/logger.js';
import { generateText, stepCountIs } from 'ai';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../lib/chat-core.js';
import { saveUserMemoryTool } from '../lib/tools/index.js';

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
        types: {},
        hasPreferences: false,
        hasContext: false
      });
      return;
    }

    // Group memories by type
    const types: Record<string, number> = {};
    memory.memories.forEach(m => {
      types[m.type] = (types[m.type] || 0) + 1;
    });

    res.json({
      totalMemories: memory.memories.length,
      types,
      hasPreferences: Object.keys(memory.preferences || {}).length > 0,
      hasContext: Object.keys(memory.context || {}).length > 0
    });
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error fetching memory stats');
    res.status(500).json({ error: 'Failed to fetch memory stats' });
  }
});

/**
 * GET /api/memory
 * Get user's memory profile
 */
router.get('/', async (req, res) => {
  try {
    const memory = await getOrCreateUserMemory(req.user!.id);

    res.json(memory);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error fetching memory');
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
      { upsert: true, returnDocument: 'after' }
    );

    res.json(memory);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error updating context');
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
      { upsert: true, returnDocument: 'after' }
    );

    res.json(memory);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error updating preferences');
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

/**
 * PUT /api/memory/settings
 * Update memory auto-save / recall toggles
 */
router.put('/settings', async (req, res) => {
  try {
    const validation = MemorySettingsSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: 'Invalid settings data',
        details: validation.error.issues
      });
      return;
    }

    const memory = await getOrCreateUserMemory(req.user!.id);

    if (validation.data.autoSaveEnabled !== undefined) {
      memory.settings.autoSaveEnabled = validation.data.autoSaveEnabled;
    }
    if (validation.data.recallEnabled !== undefined) {
      memory.settings.recallEnabled = validation.data.recallEnabled;
    }

    await memory.save();
    res.json(memory.settings);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error updating memory settings');
    res.status(500).json({ error: 'Failed to update memory settings' });
  }
});

/**
 * POST /api/memory/add
 * Add a new memory or update if title exists
 */
router.post('/add', async (req, res) => {
  try {
    const { title, summary, type } = req.body;

    // Validate input
    const validation = AddMemorySchema.safeParse({ title, summary, type });
    if (!validation.success) {
      res.status(400).json({
        error: 'Invalid memory data',
        details: validation.error.issues
      });
      return;
    }

    const userMemory = await getOrCreateUserMemory(req.user!.id);

    // Check if memory with this title exists
    const existingMemoryIndex = userMemory.memories.findIndex(m => m.title === title);

    if (existingMemoryIndex !== -1) {
      // Update existing memory
      userMemory.memories[existingMemoryIndex].summary = summary;
      userMemory.memories[existingMemoryIndex].type = type;
      userMemory.memories[existingMemoryIndex].updatedAt = new Date();
    } else {
      // Get user's subscription to check memory limit
      const subscription = await Subscription.findOne({
        oxyUserId: req.user!.id,
        status: { $in: ['active', 'trialing'] }
      });

      const memoryLimit = getMemoryLimit(subscription?.plan?.name);

      // Check memory limit before adding new (unless unlimited)
      if (memoryLimit !== -1 && userMemory.memories.length >= memoryLimit) {
        res.status(400).json({
          error: 'Memory limit exceeded',
          limit: memoryLimit,
          current: userMemory.memories.length,
          suggestion: subscription?.plan?.name
            ? 'Upgrade to Business plan for unlimited memories'
            : 'Upgrade to Pro or Business plan for more memories'
        });
        return;
      }

      // Add new memory
      userMemory.memories.push({
        title,
        summary,
        type,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    await userMemory.save();
    res.json(userMemory);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error adding memory');
    res.status(500).json({ error: 'Failed to add memory' });
  }
});

/**
 * GET /api/memory/semantic-search
 * Semantic search across memories using vector similarity + text matching
 */
router.get('/semantic-search', async (req, res) => {
  try {
    const { q, limit = '5' } = req.query;
    if (!q || typeof q !== 'string') {
      res.status(400).json({ error: 'Query parameter "q" is required' });
      return;
    }

    const topK = Math.min(Number(limit) || 5, 20);
    const memory = await UserMemory.findOne({ oxyUserId: req.user!.id });
    if (!memory || memory.memories.length === 0) {
      res.json({ results: [], method: 'none' });
      return;
    }

    // Try vector search first
    const { generateEmbedding, searchByVector } = await import('../lib/memory/index.js');
    const queryEmbedding = await generateEmbedding(q);

    let vectorResults: { memoryKey: string; score: number }[] = [];
    if (queryEmbedding) {
      vectorResults = await searchByVector(req.user!.id, queryEmbedding, topK);
    }

    // Text search fallback
    const queryLower = q.toLowerCase();
    const textResults = memory.memories
      .map(m => {
        const titleScore = m.title.toLowerCase().includes(queryLower) ? 0.8 : 0;
        const summaryScore = m.summary.toLowerCase().includes(queryLower) ? 0.6 : 0;
        return { memoryKey: m.title, score: Math.max(titleScore, summaryScore) };
      })
      .filter(r => r.score > 0);

    // Hybrid scoring: 0.7 * vector + 0.3 * text
    const scoreMap = new Map<string, number>();
    for (const vr of vectorResults) {
      scoreMap.set(vr.memoryKey, (scoreMap.get(vr.memoryKey) || 0) + vr.score * 0.7);
    }
    for (const tr of textResults) {
      scoreMap.set(tr.memoryKey, (scoreMap.get(tr.memoryKey) || 0) + tr.score * 0.3);
    }

    // Sort by hybrid score and look up full memory data
    const sorted = Array.from(scoreMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK);

    const results = sorted.map(([title, score]) => {
      const mem = memory.memories.find(m => m.title === title);
      return mem ? { title: mem.title, summary: mem.summary, type: mem.type, score: Math.round(score * 1000) / 1000 } : null;
    }).filter(Boolean);

    res.json({
      results,
      method: queryEmbedding ? 'hybrid' : 'text',
      totalMemories: memory.memories.length,
    });
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Semantic search error');
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * PUT /api/memory/:memoryId
 * Update a specific memory
 */
router.put('/:memoryId', async (req, res) => {
  try {
    const { title, summary, type } = req.body;

    const validation = AddMemorySchema.safeParse({ title, summary, type });
    if (!validation.success) {
      res.status(400).json({
        error: 'Invalid memory data',
        details: validation.error.issues
      });
      return;
    }

    const memory = await UserMemory.findOneAndUpdate(
      {
        oxyUserId: req.user!.id,
        'memories._id': req.params.memoryId
      },
      {
        $set: {
          'memories.$.title': title,
          'memories.$.summary': summary,
          'memories.$.type': type,
          'memories.$.updatedAt': new Date()
        }
      },
      { returnDocument: 'after', runValidators: true }
    );

    if (!memory) {
      res.status(404).json({ error: 'Memory not found' });
      return;
    }

    res.json(memory);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error updating memory');
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
      { returnDocument: 'after' }
    );

    if (!memory) {
      res.status(404).json({ error: 'Memory not found' });
      return;
    }

    res.json(memory);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Error deleting memory');
    res.status(500).json({ error: 'Failed to delete memory' });
  }
});

/**
 * GET /api/memory/search
 * Search memories with pagination and filtering
 */
router.get('/search', async (req, res) => {
  try {
    const { q, type, limit = '50', offset = '0', sortBy = 'updatedAt' } = req.query;

    const memory = await UserMemory.findOne({ oxyUserId: req.user!.id });
    if (!memory) {
      res.json({ memories: [], total: 0, limit: Number(limit), offset: Number(offset) });
      return;
    }

    let filtered = [...memory.memories];

    // Text search across title and summary
    if (q && typeof q === 'string') {
      const query = q.toLowerCase();
      filtered = filtered.filter(m =>
        m.title.toLowerCase().includes(query) ||
        m.summary.toLowerCase().includes(query)
      );
    }

    // Type filter
    if (type && typeof type === 'string') {
      filtered = filtered.filter(m => m.type === type);
    }

    // Sort
    filtered.sort((a, b) => {
      if (sortBy === 'updatedAt') return b.updatedAt.getTime() - a.updatedAt.getTime();
      if (sortBy === 'createdAt') return b.createdAt.getTime() - a.createdAt.getTime();
      if (sortBy === 'title') return a.title.localeCompare(b.title);
      return 0;
    });

    // Paginate
    const total = filtered.length;
    const limitNum = Number(limit);
    const offsetNum = Number(offset);
    const paginated = filtered.slice(offsetNum, offsetNum + limitNum);

    res.json({
      memories: paginated,
      total,
      limit: limitNum,
      offset: offsetNum
    });
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Search error');
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * GET /api/memory/duplicates
 * Find potential duplicate memories
 */
router.get('/duplicates', async (req, res) => {
  try {
    const memory = await UserMemory.findOne({ oxyUserId: req.user!.id });
    if (!memory) {
      res.json({ duplicates: [], count: 0 });
      return;
    }

    const duplicates: any[] = [];
    for (let i = 0; i < memory.memories.length; i++) {
      for (let j = i + 1; j < memory.memories.length; j++) {
        const m1 = memory.memories[i];
        const m2 = memory.memories[j];

        // Exact summary match with different titles
        if (m1.summary.toLowerCase() === m2.summary.toLowerCase()) {
          duplicates.push({ memory1: m1, memory2: m2, reason: 'identical_summary' });
        }
        // Similar titles (case-insensitive match)
        else if (m1.title.toLowerCase() === m2.title.toLowerCase() && m1.title !== m2.title) {
          duplicates.push({ memory1: m1, memory2: m2, reason: 'similar_title' });
        }
      }
    }

    res.json({ duplicates, count: duplicates.length });
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Duplicate detection error');
    res.status(500).json({ error: 'Failed to detect duplicates' });
  }
});

/**
 * GET /api/memory/export/preview
 * Get export preview/statistics before downloading
 */
router.get('/export/preview', async (req, res) => {
  try {
    const memory = await UserMemory.findOne({ oxyUserId: req.user!.id });

    if (!memory) {
      res.json({
        totalMemories: 0,
        totalTypes: 0,
        hasPreferences: false,
        hasContext: false,
        estimatedSizeJSON: 0,
        estimatedSizeCSV: 0,
        types: [],
        oldestMemory: null,
        newestMemory: null,
      });
      return;
    }

    const types = new Set(memory.memories.map(m => m.type));

    // Rough size estimates
    const jsonStr = JSON.stringify(memory);
    const csvSize = memory.memories.reduce((acc, m) =>
      acc + m.title.length + m.summary.length + 50, 0
    );

    const oldestMemory = memory.memories.reduce((oldest: Date | null, m) =>
      !oldest || m.createdAt < oldest ? m.createdAt : oldest, null as Date | null
    );

    const newestMemory = memory.memories.reduce((newest: Date | null, m) =>
      !newest || m.updatedAt > newest ? m.updatedAt : newest, null as Date | null
    );

    res.json({
      totalMemories: memory.memories.length,
      totalTypes: types.size,
      types: Array.from(types),
      hasPreferences: Object.keys(memory.preferences || {}).length > 0,
      hasContext: Object.keys(memory.context || {}).length > 0,
      estimatedSizeJSON: jsonStr.length,
      estimatedSizeCSV: csvSize,
      oldestMemory,
      newestMemory,
    });
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Export preview error');
    res.status(500).json({ error: 'Failed to generate preview' });
  }
});

/**
 * GET /api/memory/export/json
 * Export all memory data as JSON
 */
router.get('/export/json', async (req, res) => {
  try {
    const memory = await UserMemory.findOne({ oxyUserId: req.user!.id });

    if (!memory) {
      res.status(404).json({ error: 'No memory data found' });
      return;
    }

    // Create export object with metadata
    const exportData = {
      version: '2.0',
      exportedAt: new Date().toISOString(),
      memories: memory.memories.map(m => ({
        title: m.title,
        summary: m.summary,
        type: m.type,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })),
      preferences: memory.preferences,
      context: memory.context,
    };

    // Set headers for download
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="alia-memories-${Date.now()}.json"`);

    res.json(exportData);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Export JSON error');
    res.status(500).json({ error: 'Failed to export memories' });
  }
});

/**
 * Helper function for CSV escaping
 */
function escapeCSV(field: string): string {
  if (!field) return '';
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * GET /api/memory/export/csv
 * Export memories as CSV (memories only, not preferences/context)
 */
router.get('/export/csv', async (req, res) => {
  try {
    const memory = await UserMemory.findOne({ oxyUserId: req.user!.id });

    if (!memory) {
      res.status(404).json({ error: 'No memory data found' });
      return;
    }

    // Generate CSV
    const headers = ['Title', 'Summary', 'Type', 'Created At', 'Updated At'];
    const rows = memory.memories.map(m => [
      escapeCSV(m.title),
      escapeCSV(m.summary),
      escapeCSV(m.type),
      m.createdAt.toISOString(),
      m.updatedAt.toISOString(),
    ]);

    const csv = [
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');

    // Set headers for download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="alia-memories-${Date.now()}.csv"`);

    res.send(csv);
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Export CSV error');
    res.status(500).json({ error: 'Failed to export memories' });
  }
});

/**
 * POST /api/memory/import/validate
 * Validate import data without importing
 */
router.post('/import/validate', async (req, res) => {
  try {
    const { data } = req.body;

    const validation = ImportMemorySchema.safeParse(data);

    if (!validation.success) {
      res.status(400).json({
        valid: false,
        errors: validation.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        }))
      });
      return;
    }

    const importData = validation.data;
    const memory = await UserMemory.findOne({ oxyUserId: req.user!.id });

    // Get user's subscription to check memory limit
    const subscription = await Subscription.findOne({
      oxyUserId: req.user!.id,
      status: { $in: ['active', 'trialing'] }
    });

    const memoryLimit = getMemoryLimit(subscription?.plan?.name);

    // Analyze what would happen
    const analysis = {
      valid: true,
      totalToImport: importData.memories.length,
      duplicateTitles: 0,
      newTitles: 0,
      types: new Set(importData.memories.map(m => m.type)),
      estimatedFinalTotal: (memory?.memories.length || 0),
      memoryLimit,
      isUnlimited: memoryLimit === -1,
    };

    if (memory) {
      const existingTitles = new Set(memory.memories.map(m => m.title));
      analysis.duplicateTitles = importData.memories.filter(m => existingTitles.has(m.title)).length;
      analysis.newTitles = importData.memories.filter(m => !existingTitles.has(m.title)).length;
      analysis.estimatedFinalTotal = memory.memories.length + analysis.newTitles;
    } else {
      analysis.newTitles = importData.memories.length;
      analysis.estimatedFinalTotal = importData.memories.length;
    }

    // Check if it would exceed limits (unless unlimited)
    if (memoryLimit !== -1 && analysis.estimatedFinalTotal > memoryLimit) {
      res.json({
        valid: false,
        errors: [{
          message: `Import would exceed memory limit (${analysis.estimatedFinalTotal} > ${memoryLimit})`,
        }],
        analysis: {
          ...analysis,
          types: Array.from(analysis.types),
        },
      });
      return;
    }

    res.json({
      valid: true,
      analysis: {
        ...analysis,
        types: Array.from(analysis.types),
      },
    });

  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Validation error');
    res.status(500).json({ error: 'Validation failed' });
  }
});

/**
 * POST /api/memory/import
 * Import memories from JSON file
 * Body: { data: ImportData, strategy: 'replace' | 'merge' | 'skip-duplicates' }
 */
router.post('/import', async (req, res) => {
  try {
    const { data, strategy = 'merge' } = req.body;

    // Validate strategy
    const strategyValidation = MergeStrategySchema.safeParse(strategy);
    if (!strategyValidation.success) {
      res.status(400).json({
        error: 'Invalid merge strategy',
        details: strategyValidation.error.issues
      });
      return;
    }

    // Validate import data structure
    const validation = ImportMemorySchema.safeParse(data);
    if (!validation.success) {
      res.status(400).json({
        error: 'Invalid import data format',
        details: validation.error.issues
      });
      return;
    }

    const importData = validation.data;

    // Check file size (approximate)
    const estimatedSize = JSON.stringify(importData).length;
    const MAX_IMPORT_SIZE = 5 * 1024 * 1024; // 5MB
    if (estimatedSize > MAX_IMPORT_SIZE) {
      res.status(400).json({
        error: 'Import data too large',
        maxSize: MAX_IMPORT_SIZE,
        actualSize: estimatedSize
      });
      return;
    }

    // Find or create user memory
    const memory = await getOrCreateUserMemory(req.user!.id);

    // Get user's subscription to check memory limit
    const subscription = await Subscription.findOne({
      oxyUserId: req.user!.id,
      status: { $in: ['active', 'trialing'] }
    });

    const memoryLimit = getMemoryLimit(subscription?.plan?.name);

    const stats = {
      imported: 0,
      updated: 0,
      skipped: 0,
      errors: [] as string[],
    };

    // Apply merge strategy
    if (strategy === 'replace') {
      // Replace all memories
      memory.memories = importData.memories.map(m => ({
        title: m.title,
        summary: m.summary,
        type: m.type,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      stats.imported = importData.memories.length;

      if (importData.preferences) memory.preferences = importData.preferences;
      if (importData.context) memory.context = importData.context;

    } else if (strategy === 'merge') {
      // Merge: update existing, add new
      for (const importMemory of importData.memories) {
        const existingIndex = memory.memories.findIndex(m => m.title === importMemory.title);

        if (existingIndex !== -1) {
          memory.memories[existingIndex].summary = importMemory.summary;
          memory.memories[existingIndex].type = importMemory.type;
          memory.memories[existingIndex].updatedAt = new Date();
          stats.updated++;
        } else {
          memory.memories.push({
            title: importMemory.title,
            summary: importMemory.summary,
            type: importMemory.type,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          stats.imported++;
        }
      }

      // Merge preferences and context
      if (importData.preferences) {
        memory.preferences = { ...memory.preferences, ...importData.preferences };
      }
      if (importData.context) {
        memory.context = { ...memory.context, ...importData.context };
      }

    } else if (strategy === 'skip-duplicates') {
      // Only add memories that don't exist
      for (const importMemory of importData.memories) {
        const exists = memory.memories.some(m => m.title === importMemory.title);

        if (exists) {
          stats.skipped++;
        } else {
          memory.memories.push({
            title: importMemory.title,
            summary: importMemory.summary,
            type: importMemory.type,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          stats.imported++;
        }
      }
    }

    // Check total memory limit (unless unlimited)
    if (memoryLimit !== -1 && memory.memories.length > memoryLimit) {
      res.status(400).json({
        error: 'Memory limit exceeded',
        limit: memoryLimit,
        current: memory.memories.length
      });
      return;
    }

    await memory.save();

    res.json({
      success: true,
      stats,
      totalMemories: memory.memories.length,
    });

  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Import error');
    res.status(500).json({ error: 'Failed to import memories' });
  }
});

/**
 * POST /api/memory/import/from-text
 * Import memories from pasted text (e.g. a memory summary exported from
 * another AI assistant). Reuses saveUserMemoryTool via a single scoped
 * generateText call — no bespoke parsing logic. Runs regardless of
 * settings.autoSaveEnabled: this is an explicit user-initiated action.
 */
router.post('/import/from-text', async (req, res) => {
  try {
    const { text } = req.body as { text?: string };

    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    if (text.length > 50_000) {
      res.status(400).json({ error: 'Text is too long (max 50,000 characters)' });
      return;
    }

    const userId = req.user!.id;

    const resolved = await resolveModel(getDefaultAliaModel());
    if (!resolved) {
      res.status(503).json({ error: 'No AI models available. Please try again later.' });
      return;
    }

    const model = getAIModel(resolved.keyConfig);
    const saveTool = saveUserMemoryTool(userId);

    const systemPrompt = `You are extracting memories from a block of text pasted by the user — typically a memory/context summary exported from another AI assistant. Read the text and call the saveUserMemory tool once for EACH distinct fact worth remembering. Choose type per fact: "profile" for facts about the user themself, "topic" for a subject/interest/project, "person" for someone in the user's life. Give each memory a short, human-readable title (2-4 words) and a 1-2 sentence summary. Do not invent facts that aren't in the text. If the text contains no memorable facts, don't call the tool at all.`;

    const result = await generateText({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
      tools: { saveUserMemory: saveTool },
      temperature: 0.2,
      maxRetries: 0,
      stopWhen: stepCountIs(20),
    });

    const saved = (result.toolResults || [])
      .filter((tr: any) => tr.toolName === 'saveUserMemory' && tr.output?.success)
      .map((tr: any) => ({
        title: tr.input?.title,
        summary: tr.input?.summary,
        type: tr.input?.type,
      }));

    res.json({ saved });
  } catch (error: unknown) {
    log.memory.error({ err: error }, 'Import-from-text error');
    res.status(500).json({ error: 'Failed to import from text' });
  }
});

export default router;
