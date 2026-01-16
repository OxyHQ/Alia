import { tool } from "ai";
import { z } from "zod";
import { UserMemory } from "../../models/user-memory.js";

/**
 * Tool to save user memories
 * Allows the AI to remember important information about the user
 */
export const saveUserMemoryTool = (userId: string) => tool({
  description: 'Save important user information for future conversations. Use ALWAYS when user shares: preferences, personal info, goals, experiences, or anything they want remembered.',

  inputSchema: z.object({
    key: z.string().describe('Short descriptive key (e.g., "favorite_fruit", "occupation", "pet")'),
    value: z.string().describe('Memory value/description (e.g., "strawberries", "software engineer", "dog named Max")'),
    category: z.string().optional().describe('Optional category: "preference", "personal", "goal", "experience"'),
  }),

  execute: async ({ key, value, category }) => {
    try {
      // Find the user's memory document
      let memory = await UserMemory.findOne({ userId });

      if (!memory) {
        // Create new memory document if it doesn't exist
        memory = new UserMemory({
          userId,
          memories: [],
          preferences: {},
          context: {}
        });
      }

      // Check if a memory with this key already exists
      const existingMemoryIndex = memory.memories.findIndex(m => m.key === key);

      if (existingMemoryIndex !== -1) {
        // Update existing memory
        memory.memories[existingMemoryIndex].value = value;
        memory.memories[existingMemoryIndex].category = category;
        memory.memories[existingMemoryIndex].updatedAt = new Date();
      } else {
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

      return {
        success: true,
        message: `Recuerdo guardado exitosamente: ${key} = ${value}`,
        totalMemories: memory.memories.length
      };
    } catch (error: any) {
      console.error('[saveUserMemoryTool] Error:', error);
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
export const updateUserPreferencesTool = (userId: string) => tool({
  description: 'Update user communication preferences: language, tone, response length, interests.',

  inputSchema: z.object({
    language: z.string().optional().describe('Preferred language (e.g., "Spanish", "English", "French")'),
    tone: z.string().optional().describe('Preferred tone (e.g., "formal", "casual", "technical", "friendly")'),
    responseLength: z.enum(['short', 'medium', 'long']).optional().describe('Preferred response length'),
    interests: z.array(z.string()).optional().describe('List of user interests or topics'),
  }),

  execute: async ({ language, tone, responseLength, interests }) => {
    try {
      let memory = await UserMemory.findOne({ userId });

      if (!memory) {
        memory = new UserMemory({
          userId,
          memories: [],
          preferences: {},
          context: {}
        });
      }

      // Update preferences
      if (language) memory.preferences.language = language;
      if (tone) memory.preferences.tone = tone;
      if (responseLength) memory.preferences.responseLength = responseLength;
      if (interests) memory.preferences.interests = interests;

      await memory.save();

      return {
        success: true,
        message: 'Preferencias actualizadas exitosamente',
        preferences: memory.preferences
      };
    } catch (error: any) {
      console.error('[updateUserPreferencesTool] Error:', error);
      return {
        success: false,
        message: `Error al actualizar preferencias: ${error.message}`
      };
    }
  },
});

/**
 * Tool to update user context
 * Allows the AI to update user context like occupation, location, etc.
 */
export const updateUserContextTool = (userId: string) => tool({
  description: 'Update user context: occupation, location, timezone, bio.',

  inputSchema: z.object({
    occupation: z.string().optional().describe('User occupation/profession'),
    location: z.string().optional().describe('User location (city, country)'),
    timezone: z.string().optional().describe('User timezone'),
    bio: z.string().optional().describe('User bio or general description'),
  }),

  execute: async ({ occupation, location, timezone, bio }) => {
    try {
      let memory = await UserMemory.findOne({ userId });

      if (!memory) {
        memory = new UserMemory({
          userId,
          memories: [],
          preferences: {},
          context: {}
        });
      }

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
      console.error('[updateUserContextTool] Error:', error);
      return {
        success: false,
        message: `Error al actualizar contexto: ${error.message}`
      };
    }
  },
});
