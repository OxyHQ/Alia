import { tool } from "ai";
import { z } from "zod";
import { getMemoryLimit } from '../../models/user-memory.js';
import { MEMORY_TYPES } from '../../domain/user-memory.js';
import { Subscription } from "../../models/subscription.js";
import { getOrCreateUserMemory } from "../memory/user-memory-service.js";
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';
import { PERSONALITY_STYLES, isPersonalityStyle, type PersonalityStyleId } from '../personality-styles.js';

/**
 * Who asked for a memory write.
 *
 * The `autoSaveEnabled` setting is presented to the user as "Auto-save from
 * conversations / Automatically save information I mention" — it governs the
 * assistant capturing things on its OWN initiative, not the user asking for
 * something to be remembered. Gating both would leave a user with auto-save off
 * unable to write memory at all.
 */
const INITIATED_BY = ['user', 'assistant'] as const;
type InitiatedBy = typeof INITIATED_BY[number];

/**
 * Tool to save user memories
 * Allows the AI to remember important information about the user
 *
 * `opts.initiatedBy` lets a caller that already knows who initiated the write
 * (e.g. the memory-import route, which only runs because the user pasted text
 * and pressed import) assert it server-side instead of trusting the model's
 * own `initiatedBy` argument.
 */
export const saveUserMemoryTool = (oxyUserId: string, opts?: { initiatedBy?: InitiatedBy }) => tool({
  description: 'Save NEW user information for future conversations. Use ALWAYS when user shares: preferences, personal info, goals, experiences, or anything they want remembered. To change something already remembered — especially to rename it — use updateUserMemory instead; this tool keys off the title, so saving under a new title leaves the old memory behind as a duplicate.',

  inputSchema: z.object({
    title: z.string().describe('Short, human-readable label (e.g. "Food", "Occupation", a person\'s name) — NOT a snake_case key'),
    summary: z.string().describe('1-2 sentence description of what to remember'),
    type: z.enum(MEMORY_TYPES).describe(
      'profile = a fact about the user themself; topic = a subject/interest/project; person = someone in the user\'s life'
    ),
    initiatedBy: z.enum(INITIATED_BY).describe(
      '"user" when the user explicitly asked you to remember or save this; "assistant" when you decided to capture it yourself from something they mentioned in passing'
    ),
  }),

  execute: async ({ title, summary, type, initiatedBy }) => {
    try {
      const memory = await getOrCreateUserMemory(oxyUserId);

      const actor = opts?.initiatedBy ?? initiatedBy;
      if (actor === 'assistant' && memory.settings?.autoSaveEnabled === false) {
        return {
          success: false,
          message: 'Auto-save from conversations is disabled in the user\'s settings — do not save this on your own. If the user asks you directly to remember it, save it with initiatedBy "user".',
          disabled: true,
        };
      }

      // Check if a memory with this title already exists (case-insensitive, trimmed)
      const normalizedTitle = title.trim().toLowerCase();
      const existingMemoryIndex = memory.memories.findIndex(m => m.title.trim().toLowerCase() === normalizedTitle);

      if (existingMemoryIndex !== -1) {
        // Update existing memory
        memory.memories[existingMemoryIndex].summary = summary;
        memory.memories[existingMemoryIndex].type = type;
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
          title,
          summary,
          type,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }

      // Save to database
      await memory.save();

      // Generate embedding in background — never block the tool response
      import('../memory/index.js').then(async ({ generateEmbedding, upsertMemoryEmbedding }) => {
        const embedding = await generateEmbedding(`${title}: ${summary}`);
        if (embedding) {
          await upsertMemoryEmbedding(oxyUserId, title, embedding);
        }
        // Invalidate vector search cache so next recall picks up the new memory
        const { invalidateUserEmbeddingCache } = await import('../memory/vector-search.js');
        invalidateUserEmbeddingCache(oxyUserId);
      }).catch((err: unknown) => log.tools.error({ err }, 'Failed to index saved memory'));

      return {
        success: true,
        message: `Recuerdo guardado exitosamente: ${title} = ${summary}`,
        totalMemories: memory.memories.length
      };
    } catch (error: unknown) {
      log.tools.error({ err: error }, 'Error');
      return {
        success: false,
        message: `Error al guardar el recuerdo: ${getErrorMessage(error)}`
      };
    }
  },
});

/**
 * Tool to change a memory that already exists, addressed by its current title.
 *
 * This is the only write path that can RENAME: `saveUserMemory` matches on the
 * title, so saving under a new one creates a second memory and orphans the old.
 * Never gated by `autoSaveEnabled` — you cannot edit a memory the user is not
 * pointing at, so every call here is user-initiated by construction.
 */
export const updateUserMemoryTool = (oxyUserId: string) => tool({
  description: 'Change a memory that already exists: correct it, reword it, re-classify it, or rename its title. Use this — never saveUserMemory — whenever the user refers to something you already remember.',

  inputSchema: z.object({
    currentTitle: z.string().describe('The title of the memory to change, exactly as it is stored today'),
    title: z.string().optional().describe('New title. Omit to keep the current one'),
    summary: z.string().optional().describe('New 1-2 sentence description. Omit to keep the current one'),
    type: z.enum(MEMORY_TYPES).optional().describe(
      'New grouping: profile = a fact about the user themself; topic = a subject/interest/project; person = someone in the user\'s life. Omit to keep the current one'
    ),
  }),

  execute: async ({ currentTitle, title, summary, type }) => {
    try {
      const nextTitle = title?.trim();
      const nextSummary = summary?.trim();
      if (!nextTitle && !nextSummary && !type) {
        return {
          success: false,
          message: 'Nothing to change — pass at least one of title, summary or type.',
        };
      }

      const memory = await getOrCreateUserMemory(oxyUserId);

      const normalized = currentTitle.trim().toLowerCase();
      const index = memory.memories.findIndex(m => m.title.trim().toLowerCase() === normalized);
      if (index === -1) {
        return {
          success: false,
          message: `No memory titled "${currentTitle}" exists. Use saveUserMemory to create it instead.`,
          notFound: true,
        };
      }

      const entry = memory.memories[index];
      const previousTitle = entry.title;
      const renamedTo = nextTitle && nextTitle.toLowerCase() !== previousTitle.trim().toLowerCase()
        ? nextTitle
        : null;

      if (renamedTo && memory.memories.some((m, i) => i !== index && m.title.trim().toLowerCase() === renamedTo.toLowerCase())) {
        return {
          success: false,
          message: `Another memory is already titled "${renamedTo}". Rename to something else, or merge the two by updating that one instead.`,
          conflict: true,
        };
      }

      if (nextTitle) entry.title = nextTitle;
      if (nextSummary) entry.summary = nextSummary;
      if (type) entry.type = type;
      entry.updatedAt = new Date();

      await memory.save();

      // Re-index in background — never block the tool response. A rename changes
      // the embedding's key, so the entry under the old title has to go: leaving
      // it would let vector recall surface a title that no longer exists.
      import('../memory/index.js').then(async ({ generateEmbedding, upsertMemoryEmbedding, deleteMemoryEmbedding }) => {
        if (renamedTo) {
          await deleteMemoryEmbedding(oxyUserId, previousTitle);
        }
        const embedding = await generateEmbedding(`${entry.title}: ${entry.summary}`);
        if (embedding) {
          await upsertMemoryEmbedding(oxyUserId, entry.title, embedding);
        }
        const { invalidateUserEmbeddingCache } = await import('../memory/vector-search.js');
        invalidateUserEmbeddingCache(oxyUserId);
      }).catch((err: unknown) => log.tools.error({ err }, 'Failed to re-index updated memory'));

      return {
        success: true,
        message: renamedTo
          ? `Memory "${previousTitle}" renamed to "${entry.title}": ${entry.summary}`
          : `Memory "${entry.title}" updated: ${entry.summary}`,
        title: entry.title,
        summary: entry.summary,
        type: entry.type,
      };
    } catch (error: unknown) {
      log.tools.error({ err: error }, 'Error updating memory');
      return {
        success: false,
        message: `Failed to update memory: ${getErrorMessage(error)}`,
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
    } catch (error: unknown) {
      log.tools.error({ err: error }, 'Error updating preferences');
      return {
        success: false,
        message: `Failed to update preferences: ${getErrorMessage(error)}`,
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
    } catch (error: unknown) {
      log.tools.error({ err: error }, 'Error');
      return {
        success: false,
        message: `Error al actualizar contexto: ${getErrorMessage(error)}`
      };
    }
  },
});
