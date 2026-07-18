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
import { getUserLanguage } from '../../memory/user-memory-service.js';
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
  "title": "A short, tappable label written as something the USER would ask Alia — imperative, first person (e.g. 'Remind me about my visa renewal', 'Track the Pixel 11 Pro price'). 4-8 words. (if not none)",
  "description": "A complete, ready-to-send message phrased as something the USER would type TO Alia to request this — imperative, first person, addressed to the assistant (e.g. 'Remind me about my visa renewal in March', 'Track the price of the Pixel 11 Pro and tell me when it drops'). NEVER phrase it as Alia describing what it will do (do NOT write 'I will remind you...' or 'Alia will track...'). (if not none)",
  "triggerConfig": {
    "type": "schedule",
    "scheduleType": "daily" | "interval",
    "prompt": "What the AI should do when triggered"
  }
}

The "title" and "description" are shown to the user as a suggestion chip and are sent VERBATIM as the user's own chat message when tapped, so they MUST read as the user speaking to Alia, never as Alia speaking to the user. This rule applies in EVERY language you respond in — match the language the user wrote in, but always keep the user's own voice, never the assistant's.
- Good (English): "Remind me about the Pixel 11 Pro release date"
- Bad (English): "I will remind you of the Pixel 11 Pro release date"
- Good (Spanish): "Recuérdame la fecha de lanzamiento del Pixel 11 Pro"
- Bad (Spanish): "Te recordaré la fecha de lanzamiento del Pixel 11 Pro"

Only suggest actions that would genuinely help. Be conservative — only classify as non-"none" when the opportunity is clear and actionable.`;

/**
 * Heuristic check for assistant-voice phrasing (first-person offers/promises)
 * in text that's supposed to read as the user speaking to Alia. Covers the
 * two languages this app actually ships (English/Spanish) — not exhaustive,
 * but catches the concrete failure modes seen in production.
 */
const ASSISTANT_VOICE_PATTERNS: RegExp[] = [
  // English: "I'll...", "I will...", "I can...", "Let me...", "I'd be happy to..."
  /^(i'll|i will|i can|i'm going to|i am going to|let me|i'd be happy to|i would be happy to)\b/i,
  // Spanish: "Te recordaré...", "Te avisaré..." (first-person future verb after "te").
  // Uses \S*/lookahead instead of \w+/\b because JS's non-unicode \w and \b
  // exclude accented letters (é) — \w+ could never consume the "é" in
  // "recordaré", so \b would never find a boundary right after the suffix.
  /^te\s+\S*(ré|aré|eré|iré)(?=[\s.,!?;:]|$)/i,
  // Spanish: "Recordarte...", "Avisarte...", "Notificarte..." (infinitive+te offer framing)
  /^(recordarte|avisarte|notificarte|informarte|ayudarte)\b/i,
  // Spanish: "Voy a...", "Puedo..." (assistant offering to do something)
  /^(voy a|puedo)\s+\w+/i,
];

function looksLikeAssistantVoice(text: string): boolean {
  return ASSISTANT_VOICE_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

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
    // Kicked off now so it overlaps the LLM round-trip below instead of adding
    // its own latency after — getUserLanguage never throws, so it's safe to
    // leave unawaited on the early-return paths above/below.
    const languagePromise = getUserLanguage(ctx.userId);

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
        maxOutputTokens: 300,
        maxRetries: 0,
      });

      const text = result.text?.trim();
      if (!text) return;

      // Parse JSON response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const classification = JSON.parse(jsonMatch[0]);
      if (classification.category === 'none' || !classification.title) return;

      const suggestionDescription = classification.description || classification.title;
      if (looksLikeAssistantVoice(classification.title) || looksLikeAssistantVoice(suggestionDescription)) {
        log.chat.warn(
          { userId: ctx.userId, title: classification.title, description: suggestionDescription },
          'Proactive suggestion discarded — phrased in assistant voice instead of user voice',
        );
        return;
      }

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
        language: await languagePromise,
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
