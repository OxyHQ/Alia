import { tool } from 'ai';
import { z } from 'zod';
import { getMemoryLimit, MEMORY_TYPES } from '../../domain/user-memory.js';
import { getDb } from '../../db/index.js';
import { findActiveSubscription } from '../../db/billing/subscriptionRepository.js';
import {
  countEntries,
  deleteEntryById,
  findEntryByTitle,
  mergeContext,
  mergePreferences,
  normalizeMemoryTitle,
  saveEntryByTitle,
  updateEntryById,
} from '../../db/memory/userMemoryRepository.js';
import { getOrCreateUserMemory } from '../memory/user-memory-service.js';
import { log } from '../logger.js';
import { KaanaCapabilityUnavailableError } from '../inference/hosted-capability-error.js';
import { getErrorMessage } from '../errors/index.js';
import {
  PERSONALITY_STYLES,
  isPersonalityStyle,
  type PersonalityStyleId,
} from '../personality-styles.js';

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
type InitiatedBy = (typeof INITIATED_BY)[number];

/**
 * Tool to save user memories
 * Allows the AI to remember important information about the user
 *
 * `opts.initiatedBy` lets a caller that already knows who initiated the write
 * (e.g. the memory-import route, which only runs because the user pasted text
 * and pressed import) assert it server-side instead of trusting the model's
 * own `initiatedBy` argument.
 */
export const saveUserMemoryTool = (oxyUserId: string, opts?: { initiatedBy?: InitiatedBy }) =>
  tool({
    description:
      'Save NEW user information for future conversations, without asking: preferences, personal info, goals, experiences, anything they want remembered — not one-off facts or asides. To change or rename something already remembered use updateUserMemory: this tool keys off the title, so a new title leaves the old memory behind as a duplicate.',

    inputSchema: z.object({
      title: z
        .string()
        .describe(
          'Short human-readable label (e.g. "Food", a person\'s name), not a snake_case key',
        ),
      summary: z.string().describe('1-2 sentences to remember'),
      type: z
        .enum(MEMORY_TYPES)
        .describe(
          'profile = about the user; topic = a subject, interest or project; person = someone in their life',
        ),
      initiatedBy: z
        .enum(INITIATED_BY)
        .describe(
          '"user" if they explicitly asked you to remember it; "assistant" if you chose to capture it from something they mentioned in passing',
        ),
    }),

    execute: async ({ title, summary, type, initiatedBy }) => {
      try {
        const memory = await getOrCreateUserMemory(oxyUserId);

        const actor = opts?.initiatedBy ?? initiatedBy;
        if (actor === 'assistant' && memory.settings?.autoSaveEnabled === false) {
          return {
            success: false,
            message:
              'Auto-save from conversations is disabled in the user\'s settings — do not save this on your own. If the user asks you directly to remember it, save it with initiatedBy "user".',
            disabled: true,
          };
        }

        // Does a memory with this title already exist? The fold is the same one
        // `user_memory_entries_memory_title_lower_key` enforces, so the check and
        // the write below cannot disagree about what counts as the same memory.
        const db = getDb();
        const existing = await findEntryByTitle(db, memory._id, title);

        if (!existing) {
          // Check memory limit before adding a new memory
          const subscription = await findActiveSubscription(db, oxyUserId);

          const memoryLimit = getMemoryLimit(subscription?.planSnapshotName);

          // Check if adding new memory would exceed limit (unless unlimited)
          if (memoryLimit !== -1 && memory.memories.length >= memoryLimit) {
            return {
              success: false,
              message: `Memory limit reached (${memoryLimit} memories). ${subscription?.planSnapshotName ? 'Upgrade to Business plan for unlimited memories.' : 'Upgrade your plan for more memories.'}`,
              limitReached: true,
              limit: memoryLimit,
            };
          }
        }

        // Insert, or overwrite the one already stored under this title. The
        // server does the fold, so two concurrent saves settle to one row.
        await saveEntryByTitle(db, memory._id, { title, summary, type });
        const totalMemories = await countEntries(db, memory._id);

        // Generate embedding in background — never block the tool response.
        // Embeddings fail closed until Kaana serves them; that is a known state,
        // not an error to log on every save.
        import('../memory/index.js')
          .then(async ({ generateEmbedding, upsertMemoryEmbedding }) => {
            const embedding = await generateEmbedding(`${title}: ${summary}`).catch(
              (err: unknown) => {
                if (err instanceof KaanaCapabilityUnavailableError) return null;
                throw err;
              },
            );
            if (embedding) {
              await upsertMemoryEmbedding(oxyUserId, title, embedding);
            }
            // Invalidate vector search cache so next recall picks up the new memory
            const { invalidateUserEmbeddingCache } = await import('../memory/vector-search.js');
            invalidateUserEmbeddingCache(oxyUserId);
          })
          .catch((err: unknown) => log.tools.error({ err }, 'Failed to index saved memory'));

        return {
          success: true,
          message: `Recuerdo guardado exitosamente: ${title} = ${summary}`,
          totalMemories,
        };
      } catch (error: unknown) {
        log.tools.error({ err: error }, 'Error');
        return {
          success: false,
          message: `Error al guardar el recuerdo: ${getErrorMessage(error)}`,
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
export const updateUserMemoryTool = (oxyUserId: string) =>
  tool({
    description:
      'Change an existing memory: correct, reword, re-classify or rename it. Use this, never saveUserMemory, whenever the user refers to something you already remember.',

    inputSchema: z.object({
      currentTitle: z.string().describe('Current title, exactly as stored'),
      title: z.string().optional().describe('New title; omit to keep'),
      summary: z.string().optional().describe('New 1-2 sentences; omit to keep'),
      type: z
        .enum(MEMORY_TYPES)
        .optional()
        .describe('New grouping (profile, topic, person); omit to keep'),
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

        const db = getDb();
        const found = await findEntryByTitle(db, memory._id, currentTitle);
        if (!found) {
          return {
            success: false,
            message: `No memory titled "${currentTitle}" exists. Use saveUserMemory to create it instead.`,
            notFound: true,
          };
        }

        const previousTitle = found.title;
        const renamedTo =
          nextTitle && normalizeMemoryTitle(nextTitle) !== normalizeMemoryTitle(previousTitle)
            ? nextTitle
            : null;

        /**
         * The collision check is belt AND braces. This in-JS lookup alone is one
         * two concurrent renames could both pass; the functional unique refuses
         * the second write outright — but the check is kept because it produces this specific,
         * actionable message instead of a 500 from a constraint violation.
         */
        if (renamedTo) {
          const clash = await findEntryByTitle(db, memory._id, renamedTo);
          if (clash && clash._id !== found._id) {
            return {
              success: false,
              message: `Another memory is already titled "${renamedTo}". Rename to something else, or merge the two by updating that one instead.`,
              conflict: true,
            };
          }
        }

        const entry = await updateEntryById(db, memory._id, found._id, {
          ...(nextTitle ? { title: nextTitle } : {}),
          ...(nextSummary ? { summary: nextSummary } : {}),
          ...(type ? { type } : {}),
        });
        if (!entry) {
          return {
            success: false,
            message: `No memory titled "${currentTitle}" exists. Use saveUserMemory to create it instead.`,
            notFound: true,
          };
        }

        // Re-index in background — never block the tool response. A rename changes
        // the embedding's key, so the entry under the old title has to go: leaving
        // it would let vector recall surface a title that no longer exists.
        import('../memory/index.js')
          .then(async ({ generateEmbedding, upsertMemoryEmbedding, deleteMemoryEmbedding }) => {
            if (renamedTo) {
              await deleteMemoryEmbedding(oxyUserId, previousTitle);
            }
            const embedding = await generateEmbedding(`${entry.title}: ${entry.summary}`);
            if (embedding) {
              await upsertMemoryEmbedding(oxyUserId, entry.title, embedding);
            }
            const { invalidateUserEmbeddingCache } = await import('../memory/vector-search.js');
            invalidateUserEmbeddingCache(oxyUserId);
          })
          .catch((err: unknown) => log.tools.error({ err }, 'Failed to re-index updated memory'));

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
 * "Olvida esto" — the person asking Alia to forget something she remembers.
 *
 * Deletes the entry AND its embedding: a forgotten fact must not keep a vector
 * of itself that recall could match on. Never gated by `autoSaveEnabled`, like
 * `updateUserMemory`: forgetting is always the person's own request.
 */
export const forgetUserMemoryTool = (oxyUserId: string) =>
  tool({
    description:
      'Forget a memory when the user asks you to forget it or says it is no longer true. Pass its exact title and confirm what you forgot. Never on your own initiative.',

    inputSchema: z.object({
      title: z.string().describe('Title of the memory, exactly as stored'),
    }),

    execute: async ({ title }) => {
      try {
        const memory = await getOrCreateUserMemory(oxyUserId);
        const db = getDb();
        const found = await findEntryByTitle(db, memory._id, title);
        if (!found) {
          return {
            success: false,
            message: `No memory titled "${title}" exists, so there is nothing to forget.`,
            notFound: true,
          };
        }
        await deleteEntryById(db, memory._id, found._id);
        const { deleteMemoryEmbedding } = await import('../memory/index.js');
        await deleteMemoryEmbedding(oxyUserId, found.title);
        const { invalidateUserEmbeddingCache } = await import('../memory/vector-search.js');
        invalidateUserEmbeddingCache(oxyUserId);
        return { success: true, message: `Forgot "${found.title}".`, title: found.title };
      } catch (error: unknown) {
        log.tools.error({ err: error }, 'Error forgetting memory');
        return {
          success: false,
          message: `Failed to forget the memory: ${getErrorMessage(error)}`,
        };
      }
    },
  });

/**
 * Tool to update user preferences
 * Allows the AI to update user preferences like language, tone, etc.
 */
export const updateUserPreferencesTool = (oxyUserId: string) =>
  tool({
    description:
      'Update user communication preferences: language, tone, response length, interests.',

    inputSchema: z.object({
      language: z.string().optional().describe('BCP 47 locale code, e.g. "es-ES"'),
      tone: z
        .string()
        .optional()
        .describe(
          'Personality style ("alia", "brief", "chill", "sweet") or a freeform tone ("formal")',
        ),
      responseLength: z.enum(['short', 'medium', 'long']).optional().describe('Response length'),
      interests: z.array(z.string()).optional().describe('Interests or topics'),
    }),

    execute: async ({ language, tone, responseLength, interests }) => {
      try {
        const memory = await getOrCreateUserMemory(oxyUserId);

        // Only what was supplied — a merge, so omitting a field keeps it.
        await mergePreferences(getDb(), memory._id, {
          ...(language ? { language } : {}),
          ...(tone ? { tone } : {}),
          ...(responseLength ? { responseLength } : {}),
          ...(interests ? { interests } : {}),
        });
        const preferences = {
          ...memory.preferences,
          ...(language ? { language } : {}),
          ...(tone ? { tone } : {}),
          ...(responseLength ? { responseLength } : {}),
          ...(interests ? { interests } : {}),
        };

        if (tone && isPersonalityStyle(tone)) {
          const style = PERSONALITY_STYLES[tone as PersonalityStyleId];
          return {
            success: true,
            message: `Switched to ${style.name} mode — ${style.tagline}`,
            preferences,
          };
        }

        return {
          success: true,
          message: 'Preferences updated successfully',
          preferences,
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
export const updateUserContextTool = (oxyUserId: string) =>
  tool({
    description: 'Update user context: occupation, location, timezone, bio.',

    inputSchema: z.object({
      occupation: z.string().optional().describe('Occupation'),
      location: z.string().optional().describe('City, country'),
      timezone: z.string().optional().describe('Timezone'),
      bio: z.string().optional().describe('Short bio'),
    }),

    execute: async ({ occupation, location, timezone, bio }) => {
      try {
        const memory = await getOrCreateUserMemory(oxyUserId);

        // Only what was supplied — a merge, so omitting a field keeps it.
        await mergeContext(getDb(), memory._id, {
          ...(occupation ? { occupation } : {}),
          ...(location ? { location } : {}),
          ...(timezone ? { timezone } : {}),
          ...(bio ? { bio } : {}),
        });
        const context = {
          ...memory.context,
          ...(occupation ? { occupation } : {}),
          ...(location ? { location } : {}),
          ...(timezone ? { timezone } : {}),
          ...(bio ? { bio } : {}),
        };

        return {
          success: true,
          message: 'Contexto actualizado exitosamente',
          context,
        };
      } catch (error: unknown) {
        log.tools.error({ err: error }, 'Error');
        return {
          success: false,
          message: `Error al actualizar contexto: ${getErrorMessage(error)}`,
        };
      }
    },
  });
