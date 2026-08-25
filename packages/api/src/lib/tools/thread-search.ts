/**
 * The agent looking back through its OWN thread with this person.
 *
 * A thread at `/a/:username` is permanent, so the interesting thing a person
 * said may be a thousand turns above the window the model is given. This is how
 * it gets back — and it is the same index and the SAME QUERY the person's own
 * search uses (`searchMessages`), so "what counts as text" is defined once.
 *
 * ## Text, not embeddings, deliberately
 *
 * The obvious alternative is an embedding per message and a vector recall. It
 * was refused on two measured grounds:
 *
 *  - an embedding call per turn, forever, on a path that already reserves
 *    credits; and
 *  - a second store that grows without bound. `db/schema/context-graph.ts`
 *    records that the autonomy graph already mints a node per chat turn and
 *    that **nothing reaps them** — a problem ported from Mongo, not introduced
 *    — so message embeddings would make that two unbounded stores with the
 *    retention question still unanswered.
 *
 * A `tsvector` index adds no store: it indexes a column that already exists.
 * **If the text search proves too blunt** — somebody looking for a concept they
 * never wrote the word for — embeddings are the right answer, and what should
 * justify adding them is a measurement of this failing rather than the absence
 * of one.
 *
 * ## The whole thread, not the current conversation
 *
 * A thread is MANY conversations sharing one `agent_id`, so this searches the
 * pair. Searching only the active stretch would be the same as not searching:
 * everything in it is already in the window the model was given.
 *
 * ## Bound to the turn, not chosen by the model
 *
 * `agentId` is closed over rather than being an argument. A model given one as
 * a parameter would be one hallucinated uuid away from asking for somebody
 * else's history, and the owner is in the WHERE either way — so the parameter
 * would buy nothing and could only ever be wrong.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { searchThread } from '../../db/chat/messageRepository.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';

/** How many turns one recall may pull into the context window. */
const MAX_HITS = 10;

export const createSearchThreadTool = (oxyUserId: string, agentId: string) =>
  tool({
    description:
      'Search everything said earlier in THIS conversation, including turns far above what you can currently see. Use it whenever the person refers to something from before — a decision, a name, a preference, a link — rather than saying you do not remember. EVERY word in the query must appear in the message, so search for one or two distinctive words the person would actually have written, never a whole question.',

    inputSchema: z.object({
      query: z
        .string()
        .describe(
          'One or two distinctive words that would appear in the message. All of them must be present, so more words means fewer results — not more. Quotes match a phrase; a leading minus excludes a word.',
        ),
    }),

    execute: async ({ query }) => {
      try {
        const trimmed = query.trim();
        if (trimmed === '') {
          return { results: [], message: 'Nothing was searched for.' };
        }

        const hits = await searchThread(getDb(), {
          oxyUserId,
          agentId,
          query: trimmed,
          limit: MAX_HITS,
        });

        return {
          results: hits.map((hit) => ({
            role: hit.role,
            text: hit.text,
            at: hit.createdAt.toISOString(),
          })),
          /**
           * An empty result gets a SENTENCE, not just an empty array.
           *
           * A model handed `{ results: [] }` reliably decides the tool is
           * broken and either retries the same query or apologises for a
           * failure that did not happen. Saying what an empty result MEANS —
           * and that every word had to be present, which is the thing a model
           * typing a sentence gets wrong — turns it into an answer it can act
           * on.
           */
          ...(hits.length === 0
            ? {
                message:
                  'No message in this conversation contains ALL of those words. That is an answer, not a failure — the search works. Try fewer, more distinctive words: every word in the query has to be present, so a question finds nothing.',
              }
            : {}),
        };
      } catch (error: unknown) {
        log.chat.error({ err: error, agentId }, 'Thread search failed');
        return { results: [], error: getErrorMessage(error) };
      }
    },
  });
