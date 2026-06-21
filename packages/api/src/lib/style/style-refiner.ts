/**
 * Writing Style LLM Refiner
 * Periodically uses a cheap LLM to validate/refine the heuristic analysis.
 * Max once per 7 days per user. Cost: ~$0.001-0.003 per refinement.
 */

import { generateText } from 'ai';
import { resolveModel, getAIModel } from '../chat-core.js';
import { log } from '../logger.js';
import type { IWritingStyleProfile } from '../../models/user-memory.js';
import { Message } from '../../models/message.js';

/**
 * Refine the writing style profile using an LLM.
 * Uses the cheapest available model (alia-lite).
 */
export async function refineStyleWithLLM(
  userId: string,
  profile: IWritingStyleProfile,
  recentMessages: string[],
): Promise<Partial<IWritingStyleProfile>> {
  try {
    // If no recent messages provided, fetch from conversation history
    let messages = recentMessages;
    if (messages.length === 0) {
      const recentUserMsgs = await Message.find({
        oxyUserId: userId,
        role: 'user',
        content: { $type: 'string' },
      })
        .sort({ createdAt: -1 })
        .limit(30)
        .select('content')
        .lean();

      messages = recentUserMsgs.reverse().map((m: any) => m.content);
    }

    if (messages.length < 5) {
      log.chat.info('Not enough messages for LLM refinement');
      return {};
    }

    // Resolve cheapest model
    const resolved = await resolveModel('alia-lite');
    if (!resolved) {
      log.chat.warn('No model available for style refinement');
      return {};
    }

    const model = getAIModel(resolved.keyConfig);

    // Build prompt with heuristic analysis and sample messages
    const sampleMessages = messages.slice(-20).map((m, i) => `${i + 1}. "${m}"`).join('\n');

    const prompt = `Analyze this user's writing style based on their messages and the existing heuristic analysis. Respond in JSON only.

## Current Heuristic Analysis
- Formality: ${profile.formality}
- Vocabulary level: ${profile.vocabularyLevel}
- Avg sentence length: ${profile.avgSentenceLength} words
- Sentence complexity: ${profile.sentenceComplexity}
- Capitalization: ${profile.capitalizationStyle}
- Emoji frequency: ${profile.emojiFrequency}
- Uses exclamation marks: ${profile.usesExclamationMarks}
- Uses ellipsis: ${profile.usesEllipsis}
- Primary language: ${profile.primaryLanguage}
- Greeting patterns: ${profile.greetingPatterns.join(', ') || 'none detected'}
- Closing patterns: ${profile.closingPatterns.join(', ') || 'none detected'}

## Sample Messages
${sampleMessages}

## Instructions
Based on the messages above, provide:
1. "toneDescriptors": Array of 3-5 adjectives describing the user's tone (e.g. ["friendly", "direct", "professional"])
2. "llmSummary": A concise 1-2 sentence description of how this person writes (max 300 chars). Write it in the same language the user primarily uses.
3. "jargonTerms": Array of domain-specific or distinctive terms the user frequently uses (max 10)
4. "formality": If the heuristic is wrong, provide the correct value: "very_informal" | "informal" | "neutral" | "formal" | "very_formal". Otherwise omit.
5. "vocabularyLevel": If the heuristic is wrong, provide: "basic" | "intermediate" | "advanced" | "technical". Otherwise omit.

Respond with ONLY valid JSON, no markdown or explanation.`;

    const result = await generateText({
      model,
      prompt,
      maxRetries: 1,
      temperature: 0.3,
    });

    // Parse response
    const text = result.text.trim();
    // Remove markdown code fences if present
    const jsonStr = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(jsonStr);

    const refinement: Partial<IWritingStyleProfile> = {};

    if (Array.isArray(parsed.toneDescriptors)) {
      refinement.toneDescriptors = parsed.toneDescriptors.slice(0, 5).map(String);
    }

    if (typeof parsed.llmSummary === 'string' && parsed.llmSummary.length <= 500) {
      refinement.llmSummary = parsed.llmSummary;
    }

    if (Array.isArray(parsed.jargonTerms)) {
      refinement.jargonTerms = parsed.jargonTerms.slice(0, 10).map(String);
    }

    const validFormalities = ['very_informal', 'informal', 'neutral', 'formal', 'very_formal'] as const;
    if (parsed.formality && validFormalities.includes(parsed.formality)) {
      refinement.formality = parsed.formality;
    }

    const validVocab = ['basic', 'intermediate', 'advanced', 'technical'] as const;
    if (parsed.vocabularyLevel && validVocab.includes(parsed.vocabularyLevel)) {
      refinement.vocabularyLevel = parsed.vocabularyLevel;
    }

    log.chat.info({ refinement: Object.keys(refinement) }, 'Style LLM refinement completed');
    return refinement;
  } catch (error) {
    log.chat.error({ err: error }, 'Style LLM refinement failed');
    return {};
  }
}
