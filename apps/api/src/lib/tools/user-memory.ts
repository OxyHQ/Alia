import { tool } from "ai";
import { z } from "zod";
import { UserMemory } from "../../models/user-memory.js";

/**
 * Tool to save user memories
 * Allows the AI to remember important information about the user
 */
export const saveUserMemoryTool = (userId: string) => tool({
  description: `Guarda información importante sobre el usuario en la memoria a largo plazo.

CUÁNDO USAR: Úsala SIEMPRE que el usuario comparta información personal sobre sí mismo como:
- Preferencias (comidas favoritas, colores, actividades, etc.)
- Información personal (ocupación, ubicación, edad, familia, mascotas, etc.)
- Metas u objetivos
- Experiencias o anécdotas importantes
- Cualquier dato que el usuario quiera que recuerdes

IMPORTANTE: Esta información se recordará en futuras conversaciones. Sé selectivo y guarda solo información relevante y útil.`,

  inputSchema: z.object({
    key: z.string().describe("Una clave descriptiva corta para este recuerdo (ej: 'fruta_favorita', 'ocupacion', 'mascota')"),
    value: z.string().describe("El valor o descripción del recuerdo (ej: 'fresa', 'ingeniero de software', 'perro llamado Max')"),
    category: z.string().optional().describe("Categoría opcional: 'preferencia', 'personal', 'objetivo', 'experiencia', etc."),
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
  description: `Actualiza las preferencias del usuario (idioma, tono de respuesta, longitud de respuestas, intereses).

CUÁNDO USAR: Cuando el usuario exprese preferencias sobre cómo quiere que le respondas:
- "Respóndeme siempre en español"
- "Prefiero respuestas cortas"
- "Háblame de manera formal/informal"
- "Me interesan temas de tecnología y ciencia"`,

  inputSchema: z.object({
    language: z.string().optional().describe("Idioma preferido del usuario (ej: 'español', 'inglés', 'francés')"),
    tone: z.string().optional().describe("Tono preferido de las respuestas (ej: 'formal', 'casual', 'técnico', 'amigable')"),
    responseLength: z.enum(['short', 'medium', 'long']).optional().describe("Longitud preferida de las respuestas"),
    interests: z.array(z.string()).optional().describe("Lista de intereses o temas de interés del usuario"),
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
  description: `Actualiza el contexto del usuario (ocupación, ubicación, biografía).

CUÁNDO USAR: Cuando el usuario comparte información contextual sobre su vida:
- "Trabajo como ingeniero de software"
- "Vivo en Madrid"
- "Soy estudiante de medicina"`,

  inputSchema: z.object({
    occupation: z.string().optional().describe("Ocupación o profesión del usuario"),
    location: z.string().optional().describe("Ubicación del usuario (ciudad, país)"),
    timezone: z.string().optional().describe("Zona horaria del usuario"),
    bio: z.string().optional().describe("Biografía o descripción general del usuario"),
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
