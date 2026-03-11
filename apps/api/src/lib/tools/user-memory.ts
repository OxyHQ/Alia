import { tool } from "ai";
import { z } from "zod";
import { getMemoryLimit } from "../../models/user-memory.js";
import { Subscription } from "../../models/subscription.js";
import { getOrCreateUserMemory } from "../memory/user-memory-service.js";
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';
import { PERSONALITY_STYLES, isPersonalityStyle, type PersonalityStyleId } from '../personality-styles.js';

/**
 * Tool to save user memories
 * Allows the AI to remember important information about the user
 */
export const saveUserMemoryTool = (oxyUserId: string) => tool({
  description: 'Save important user information for future conversations. Use ALWAYS when user shares: preferences, personal info, goals, experiences, or anything they want remembered.',

  inputSchema: z.object({
    key: z.string().describe('Short descriptive key (e.g., "favorite_fruit", "occupation", "pet")'),
    value: z.string().describe('Memory value/description (e.g., "strawberries", "software engineer", "dog named Max")'),
    category: z.string().optional().describe('Optional category: "preference", "personal", "goal", "experience"'),
  }),

  execute: async ({ key, value, category }) => {
    try {
      const memory = await getOrCreateUserMemory(oxyUserId);

      // Check if a memory with this key already exists
      const existingMemoryIndex = memory.memories.findIndex(m => m.key === key);

      if (existingMemoryIndex !== -1) {
        // Update existing memory
        memory.memories[existingMemoryIndex].value = value;
        memory.memories[existingMemoryIndex].category = category;
        memory.memories[existingMemoryIndex].updatedAt = new Date();
      } else {
        // Check memory limit before adding new memory
        const subscription = await Subscription.findOne({
          oxyUserId,
          status: { $in: ['active', 'trialing'] }
        });

        const memoryLimit = getMemoryLimit(subscription?.plan?.name);

        // Check if adding new memory would exceed limit (unless unlimited)
        if (memoryLimit !== -1 && memory.memories.length >= memoryLimit) {
          return {
            success: false,
            message: `Memory limit reached (${memoryLimit} memories). ${subscription?.plan?.name ? 'Upgrade to Business plan for unlimited memories.' : 'Upgrade your plan for more memories.'}`,
            limitReached: true,
            limit: memoryLimit
          };
        }

        // Add new memory
        memory.memories.push({
          key,
          value,
          category,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }

      // Save to database
      await memory.save();

      // Generate embedding in background (fire-and-forget)
      import('../memory/index.js').then(async ({ generateEmbedding, upsertMemoryEmbedding }) => {
        const embedding = await generateEmbedding(`${key}: ${value}`);
        if (embedding) {
          await upsertMemoryEmbedding(oxyUserId, key, embedding);
        }
        // Invalidate vector search cache so next recall picks up the new memory
        const { invalidateUserEmbeddingCache } = await import('../memory/vector-search.js');
        invalidateUserEmbeddingCache(oxyUserId);
      }).catch(() => {}); // Never block the tool response

      return {
        success: true,
        message: `Recuerdo guardado exitosamente: ${key} = ${value}`,
        totalMemories: memory.memories.length
      };
    } catch (error: any) {
      log.tools.error({ err: error }, 'Error');
      return {
        success: false,
        message: `Error al guardar el recuerdo: ${error.message}`
      };
    }
  },
});

/**
 * Tool to update user preferences
 * Allows the AI to update user preferences like language, tone, etc.
 */
export const updateUserPreferencesTool = (oxyUserId: string) => tool({
  description: 'Update user communication preferences: language, tone, response length, interests.',

  inputSchema: z.object({
    language: z.string().optional().describe('Preferred language as BCP 47 locale code (e.g., "en-US", "es-ES", "fr-FR")'),
    tone: z.string().optional().describe('Personality style ("alia", "brief", "chill", "sweet") or freeform tone (e.g., "formal", "casual")'),
    responseLength: z.enum(['short', 'medium', 'long']).optional().describe('Preferred response length'),
    interests: z.array(z.string()).optional().describe('List of user interests or topics'),
  }),

  execute: async ({ language, tone, responseLength, interests }) => {
    try {
      const memory = await getOrCreateUserMemory(oxyUserId);

      // Update preferences
      if (language) memory.preferences.language = language;
      if (tone) memory.preferences.tone = tone;
      if (responseLength) memory.preferences.responseLength = responseLength;
      if (interests) memory.preferences.interests = interests;

      await memory.save();

      if (tone && isPersonalityStyle(tone)) {
        const style = PERSONALITY_STYLES[tone as PersonalityStyleId];
        return {
          success: true,
          message: `Switched to ${style.name} mode — ${style.tagline}`,
          preferences: memory.preferences,
        };
      }

      return {
        success: true,
        message: 'Preferences updated successfully',
        preferences: memory.preferences,
      };
    } catch (error: any) {
      log.tools.error({ err: error }, 'Error updating preferences');
      return {
        success: false,
        message: `Failed to update preferences: ${error.message}`,
      };
    }
  },
});

/**
 * Tool to update user context
 * Allows the AI to update user context like occupation, location, etc.
 */
export const updateUserContextTool = (oxyUserId: string) => tool({
  description: 'Update user context: occupation, location, timezone, bio.',

  inputSchema: z.object({
    occupation: z.string().optional().describe('User occupation/profession'),
    location: z.string().optional().describe('User location (city, country)'),
    timezone: z.string().optional().describe('User timezone'),
    bio: z.string().optional().describe('User bio or general description'),
  }),

  execute: async ({ occupation, location, timezone, bio }) => {
    try {
      const memory = await getOrCreateUserMemory(oxyUserId);

      // Update context
      if (occupation) memory.context.occupation = occupation;
      if (location) memory.context.location = location;
      if (timezone) memory.context.timezone = timezone;
      if (bio) memory.context.bio = bio;

      await memory.save();

      return {
        success: true,
        message: 'Contexto actualizado exitosamente',
        context: memory.context
      };
    } catch (error: any) {
      log.tools.error({ err: error }, 'Error');
      return {
        success: false,
        message: `Error al actualizar contexto: ${error.message}`
      };
    }
  },
});
