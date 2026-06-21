import { Router } from 'express';
import { generateText } from 'ai';
import { Agent, AGENT_ARCHETYPES } from '../../models/agent.js';
import { authenticateToken } from '../../middleware/auth.js';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../../lib/chat-core.js';
import { log } from '../../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

// POST /agents/generate - AI generates agent config from natural language prompt
router.post('/generate', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
      return res.status(400).json({ error: 'A prompt of at least 10 characters is required' });
    }

    // Provider fallback retry loop (mirrors v1/chat-completions pattern)
    const MAX_PROVIDER_RETRIES = 3;
    const skipProviders = new Set<string>();
    let result: Awaited<ReturnType<typeof generateText>> | null = null;

    for (let attempt = 0; attempt < MAX_PROVIDER_RETRIES; attempt++) {
      const resolved = await resolveModel(getDefaultAliaModel(), skipProviders);
      if (!resolved) {
        if (attempt === 0) {
          return res.status(503).json({ error: 'No AI models available' });
        }
        break;
      }

      try {
        const model = getAIModel(resolved.keyConfig);
        result = await generateText({
          model,
          messages: [
            {
              role: 'system',
              content: `You are an agent configuration generator. Given a user's description of what they want their AI agent to do, generate a structured JSON configuration for the agent.

Return ONLY valid JSON with these fields:
- "name": A short, memorable name for the agent (2-4 words max)
- "tagline": A one-sentence description (under 100 chars)
- "description": A detailed description of the agent's purpose and behavior (2-3 sentences)
- "systemPrompt": Detailed instructions for the agent including its role, goals, behavior guidelines, and how it should interact with users. This should be comprehensive and specific.
- "category": Exactly one of: "Assistant", "Creative", "Developer", "Research", "Business", "Education"
- "tags": An array of 3-5 relevant lowercase tags
- "capabilities": An array of tool IDs this agent should have enabled. Choose from: "web-browsing", "code-execution", "web-search", "web-scraping", "file-management", "image-generation", "memory", "agent-delegation". Pick only the ones relevant to the agent's purpose.
- "archetype": Exactly one of: "general", "qa", "task_router", "status_update". Use "qa" if the agent answers questions from knowledge/data sources. Use "task_router" if the agent triages and routes tasks to people or teams. Use "status_update" if the agent gathers data and generates periodic reports or summaries. Use "general" for everything else.

Do not include any text outside the JSON object.`,
            },
            {
              role: 'user',
              content: prompt.trim(),
            },
          ],
          temperature: 0.7,
          maxRetries: 0,
        });
        break; // Success — exit retry loop
      } catch (providerError: unknown) {
        log.agents.error({ err: providerError, provider: resolved.provider, attempt }, 'Provider failed for agent generation');
        skipProviders.add(resolved.provider);
        if (attempt >= MAX_PROVIDER_RETRIES - 1) throw providerError;
      }
    }

    if (!result) {
      return res.status(503).json({ error: 'No AI models available' });
    }

    const responseText = result.text || '';

    // Parse JSON from the response (handle potential markdown code blocks)
    let parsed: any;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      log.agents.error({ responseText }, 'Failed to parse AI-generated agent config');
      return res.status(500).json({ error: 'Failed to generate agent configuration' });
    }

    // Generate handle from name
    const baseName = (parsed.name || 'agent').trim();
    let handle = baseName
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');

    // Check handle uniqueness, append suffix if needed
    const existing = await Agent.findOne({ handle });
    if (existing) {
      handle = `${handle}-${Date.now().toString(36).slice(-4)}`;
    }

    const validArchetypes = AGENT_ARCHETYPES;
    res.json({
      name: parsed.name || 'New Agent',
      handle,
      tagline: parsed.tagline || '',
      description: parsed.description || '',
      systemPrompt: parsed.systemPrompt || '',
      category: ['Assistant', 'Creative', 'Developer', 'Research', 'Business', 'Education'].includes(parsed.category)
        ? parsed.category
        : 'Assistant',
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 10) : [],
      capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities.slice(0, 10) : [],
      archetype: validArchetypes.includes(parsed.archetype) ? parsed.archetype : 'general',
    });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error generating agent config');
    res.status(500).json({ error: 'Failed to generate agent configuration' });
  }
});

export default router;
