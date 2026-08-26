import { Router } from 'express';
import { generateText } from 'ai';
import { AGENT_ARCHETYPES } from '../../domain/agent.js';
import { AGENT_COLORS, agentColorFor, isAgentColor } from '../../domain/agent-color.js';
import { FIXED_CAPABILITY_FAMILIES } from '../../domain/capability-grants.js';
import { accountCategoryChoices, isOfferedAccountCategory } from '../../lib/account-category.js';
import { fallbackAgentUsername, suggestAgentUsername } from '../../lib/agent-identity.js';
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
        const model = getAIModel(resolved, 'authoring');
        result = await generateText({
          model,
          messages: [
            {
              role: 'system',
              content: `You are an agent configuration generator. Given a user's description of what they want their AI agent to do, generate a structured JSON configuration for the agent.

Return ONLY valid JSON with these fields:
- "name": A GIVEN NAME for the agent, as you would name a person — "Claudio", "Nadia", "Bruno", "Xiomara". Never a job title: not "Community Manager", not "Support Bot", not "Research Assistant". Prefer the distinctive over the ordinary: not "Albert", "John" or "Maria". One or two words.
- "tagline": A one-sentence description (under 100 chars)
- "description": A detailed description of the agent's purpose and behavior (2-3 sentences)
- "systemPrompt": Detailed instructions for the agent including its role, goals, behavior guidelines, and how it should interact with users. This should be comprehensive and specific.
- "category": Exactly one of: "Assistant", "Creative", "Developer", "Research", "Business", "Education"
- "color": Exactly one of: ${AGENT_COLORS.map((c) => `"${c}"`).join(', ')}. The agent has no picture — it is drawn as a glyph in this colour — so pick the one that suits what it does.
- "tags": An array of 3-5 relevant lowercase tags
- "capabilityGrants": An array of capability families this agent may reach. Choose from: ${FIXED_CAPABILITY_FAMILIES.map((f) => `"${f}"`).join(', ')}. The agent gets NOTHING it is not granted, so pick every family its purpose needs and none it does not.
- "accountCategory": What the agent is ABOUT, exactly one of: ${accountCategoryChoices}. This is the SUBJECT and "category" above is the KIND of agent: answer each on its own, they need not agree. Omit the field entirely if none of them fits — no category is better than a wrong one.
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
      // The whole model output, at `error`, on a path a malformed generation
      // reaches every time (#139 ws19). Its length separates "the model said
      // nothing" from "the model said something that is not JSON".
      log.agents.error({ responseChars: responseText.length }, 'Failed to parse AI-generated agent config');
      return res.status(500).json({ error: 'Failed to generate agent configuration' });
    }

    /**
     * A SUGGESTION, not a reservation, and that is the whole difference.
     *
     * This used to slugify the name, ask Alia's own `agents` table whether the
     * handle was taken and append a timestamp suffix if it was — a check-then-
     * insert race whose collision surfaced as a 500 rather than a 409. Handles
     * are Oxy's now and the namespace is the WHOLE account graph, so no query
     * here could answer the question even in principle. The client offers this
     * to `POST /accounts` and Oxy resolves uniqueness, which is the only place
     * that can.
     */
    const validArchetypes = AGENT_ARCHETYPES;

    /**
     * Oxy's category for the bot ACCOUNT, which is a different question from
     * Alia's `category` below and answered in a different language.
     *
     * This one is a closed taxonomy owned by `@oxyhq/contracts` and lives on
     * the account, where the account graph and every profile surface outside
     * Alia can read it. Alia's own `category` is free text that feeds the
     * catalogue's `ilike` search and is rendered nowhere. Neither can stand in
     * for the other: merging them would either cost the search its free text or
     * hand Oxy an id it does not know.
     *
     * THE TWO MAY DIVERGE, AND THAT IS NOT A BUG. `category: "Research"` beside
     * `accountCategory: "finance"` is the right answer for an agent that reads
     * markets — one names the KIND of agent, the other the SUBJECT of the
     * account, and different questions are allowed different answers. Deriving
     * either from the other fails in both directions: no subject says whether
     * an agent assists or writes code, and "Assistant" fits all forty-six of
     * them. So the model is never asked to make them match, because agreement
     * across axes is not coherence — it is what files a "Developer" agent about
     * money under `software`.
     *
     * Validated, never trusted — a model asked for a closed vocabulary invents
     * members of it, and `community_management` is exactly the kind of thing it
     * will propose. Anything the taxonomy does not recognise is dropped rather
     * than corrected, because no category is a valid state and a wrong one is
     * not.
     */
    const accountCategory = isOfferedAccountCategory(parsed.accountCategory)
      ? parsed.accountCategory
      : undefined;
    // `null` when the name shapes into nothing the schema accepts — a
    // two-letter agent, or a name of pure punctuation. The fallback is the
    // caller's call, and here there is nobody to ask.
    const suggestedUsername = suggestAgentUsername(parsed.name || 'agent') ?? fallbackAgentUsername();
    res.json({
      name: parsed.name || 'New Agent',
      suggestedUsername,
      // Omitted rather than null when nothing fitted: the client forwards this
      // straight to `CreateAccountInput.accountCategories`, where absent means
      // "no categories" and an empty array means "clear them".
      ...(accountCategory === undefined ? {} : { accountCategory }),
      /**
       * A SUGGESTION too, and the same shape as the archetype below it: a model
       * asked for a closed vocabulary still invents members of it, so an
       * unoffered colour falls back rather than travelling to Oxy.
       *
       * The fallback is derived from the handle rather than random, so asking
       * twice for the same agent proposes the same colour — `domain/agent-color.ts`
       * says why this service offers colours and validates none.
       */
      color: isAgentColor(parsed.color) ? parsed.color : agentColorFor(suggestedUsername),
      tagline: parsed.tagline || '',
      description: parsed.description || '',
      systemPrompt: parsed.systemPrompt || '',
      // Alia's own axis — the kind of agent, not the subject of the account.
      // Free text in the column and the owner may later type anything, so the
      // six here are what this route OFFERS, not what the schema allows.
      category: ['Assistant', 'Creative', 'Developer', 'Research', 'Business', 'Education'].includes(parsed.category)
        ? parsed.category
        : 'Assistant',
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 10) : [],
      /**
       * Exactly the families this route OFFERED, and nothing else.
       *
       * A model asked for a closed vocabulary still invents members of it, and
       * an unrecognised grant would travel to `POST /agents` and be refused
       * there — a 400 on a body the person never typed.
       *
       * Narrower than `isCapabilityGrant` DELIBERATELY. That predicate now
       * accepts a bare `agent`, which is a real grant meaning every one of the
       * owner's active agents; a model reaching for the word while drafting an
       * agent nobody has reviewed yet would hand it a conversation with all of
       * them. What a generator proposes is limited to what its prompt named,
       * and the instanced families are granted on the editor screen, by the
       * person, one row at a time.
       */
      capabilityGrants: Array.isArray(parsed.capabilityGrants)
        ? parsed.capabilityGrants.filter(
            (grant: unknown): grant is string =>
              typeof grant === 'string' &&
              (FIXED_CAPABILITY_FAMILIES as readonly string[]).includes(grant),
          )
        : [],
      archetype: validArchetypes.includes(parsed.archetype) ? parsed.archetype : 'general',
    });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error generating agent config');
    res.status(500).json({ error: 'Failed to generate agent configuration' });
  }
});

export default router;
