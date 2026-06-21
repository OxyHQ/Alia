/**
 * Proactive Insights Hook (afterChat)
 *
 * After each conversation, analyzes whether Alia should proactively suggest:
 * - A reminder/trigger for mentioned future events or deadlines
 * - A monitoring trigger for things that change over time (prices, availability)
 * - A routine for recurring needs ("every week I have to...")
 *
 * Uses a lightweight model (alia-lite) to classify, then creates a Suggestion
 * that appears in the user's next session.
 */

import { generateText } from 'ai';
import { registerHook } from '../hook-runner.js';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../../chat-core.js';
import { Suggestion } from '../../../models/suggestion.js';
import { log } from '../../logger.js';
import crypto from 'crypto';

const CLASSIFICATION_PROMPT = `You are an AI assistant analyzer. Given the user's message and the AI's response, determine if there's an opportunity to proactively help the user with a recurring task, reminder, or monitoring.

Classify into ONE of these categories, or "none" if no proactive action is warranted:

1. "reminder" — User mentioned a future event, deadline, or something to remember (e.g., "I have a meeting next Friday", "my visa expires in March")
2. "monitor" — User asked about something that changes over time (e.g., prices, stock, availability, weather, status updates)
3. "routine" — User described a recurring need or repetitive task (e.g., "every week I have to check...", "I always forget to...")
4. "none" — No proactive action needed

Respond with ONLY a JSON object:
{
  "category": "reminder" | "monitor" | "routine" | "none",
  "title": "Short suggestion title (if not none)",
  "description": "What the trigger/routine would do (if not none)",
  "triggerConfig": {
    "type": "schedule",
    "scheduleType": "daily" | "interval",
    "prompt": "What the AI should do when triggered"
  }
}

Only suggest actions that would genuinely help. Be conservative — only classify as non-"none" when the opportunity is clear and actionable.`;

registerHook({
  name: 'proactive-insights',
  priority: 300, // Run after style-learning (200)
  afterChat: async (ctx) => {
    if (!ctx.userId) return;

    // Only analyze substantive conversations (not one-liners)
    const userMessages = ctx.messages
      .filter((m: any) => m.role === 'user')
      .map((m: any) => typeof m.content === 'string' ? m.content : '')
      .filter((text: string) => text.length > 20);

    if (userMessages.length === 0) return;

    // Only run on ~20% of conversations to save costs
    if (Math.random() > 0.2) return;

    const lastUserMessage = userMessages[userMessages.length - 1];
    const assistantResponse = ctx.response?.slice(0, 500) || '';

    try {
      const resolved = await resolveModel(getDefaultAliaModel());
      if (!resolved) return;

      const model = getAIModel(resolved.keyConfig);

      const result = await generateText({
        model,
        messages: [
          { role: 'system', content: CLASSIFICATION_PROMPT },
          {
            role: 'user',
            content: `User message: "${lastUserMessage.slice(0, 500)}"\n\nAI response: "${assistantResponse}"`,
          },
        ],
        temperature: 0.1,
        maxTokens: 300,
        maxRetries: 0,
      } as any);

      const text = result.text?.trim();
      if (!text) return;

      // Parse JSON response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const classification = JSON.parse(jsonMatch[0]);
      if (classification.category === 'none' || !classification.title) return;

      // Create a personal suggestion for the user
      const suggestionId = `proactive-${crypto.randomBytes(8).toString('hex')}`;

      await Suggestion.create({
        suggestionId,
        title: classification.title.slice(0, 100),
        text: classification.description || classification.title,
        description: classification.description?.slice(0, 200),
        type: 'welcome',
        scope: 'personal',
        oxyUserId: ctx.userId,
        language: 'en-US',
        priority: 10, // Higher priority than regular suggestions
        isAIGenerated: true,
        tags: ['proactive', classification.category],
        category: classification.category,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // Expire in 7 days
      });

      log.chat.info(
        { userId: ctx.userId, category: classification.category, title: classification.title },
        'Proactive insight created',
      );
    } catch (error) {
      // Non-blocking — don't let classification failures affect chat
      log.chat.debug({ err: error }, 'Proactive classification failed (non-blocking)');
    }
  },
});
