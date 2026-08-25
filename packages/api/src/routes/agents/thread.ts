/**
 * The thread between a person and an agent — `/a/:username`.
 *
 * ## A thread is a VIEW over many conversations, not a row
 *
 * The screen shows one continuous history. Underneath, each stretch of it is an
 * ordinary Alia conversation carrying the same `agent_id`, and there are many.
 * That is not an implementation detail: **what the model is given as context is
 * the ACTIVE conversation, not the whole thread**, so starting a new stretch is
 * what keeps that context bounded. One row forever would grow it without limit
 * and make "start a new conversation" a line that changes nothing.
 *
 * A **break is the seam between two of those conversations**, deduced from
 * which conversation each message belongs to. There is no table of breaks and
 * no endpoint to create one: starting a new stretch is `POST /conversations/new`
 * with the same `agentId`, which Alia has always been able to do.
 *
 * ## Which is why paging and search live HERE and not on a conversation
 *
 * A thread spans conversations, so `GET /conversations/:id/...` cannot serve
 * it — it would stop at the current stretch. Both take the pair, and their
 * cursor crosses the seams in order.
 *
 * ## Every refusal is 404, and a 403 would be a leak
 *
 * A stranger who guesses a handle must not be able to tell an unpublished agent
 * from a handle nobody has taken. A 403 answers that question, so
 * `loadThreadAgent` collapses the four ways of not reaching an agent — no such
 * username, a username that is a person, a draft belonging to somebody else,
 * Oxy unreachable — into one null.
 *
 * The cost is real and accepted: an owner whose Oxy is down is told their own
 * agent does not exist. Every other agent route can afford to distinguish those
 * because it addresses an agent by an id the caller had to have been given;
 * this one is addressed by a GUESSABLE handle, which is the whole difference.
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/index.js';
import {
  createConversation,
  findActiveThreadConversation,
} from '../../db/chat/conversationRepository.js';
import {
  decodeThreadCursor,
  encodeThreadCursor,
  listThreadPage,
  listThreadWindow,
  searchThread,
  toStoredMessage,
  type ThreadMessageRow,
} from '../../db/chat/messageRepository.js';
import { agentPromptName } from '../../lib/agent-identity.js';
import { loadThreadAgent } from '../../lib/agent-account.js';
import { authenticateToken } from '../../middleware/auth.js';
import { log } from '../../lib/logger.js';
import type { HydratedAgent } from '../../lib/agent-identity.js';
import type { Request, Response } from 'express';

const router = Router();

/** The one body a caller who cannot reach an agent ever sees. */
const NO_THREAD = { error: 'Agent not found' };

const MAX_PAGE = 100;
const DEFAULT_PAGE = 30;
const MAX_HITS = 50;
const DEFAULT_HITS = 20;

/** The agent behind `:username`, or `null` after the route has answered 404. */
async function reachAgent(req: Request, res: Response): Promise<HydratedAgent | null> {
  const agent = await loadThreadAgent(getDb(), {
    username: String(req.params.username),
    oxyUserId: req.user?.id ?? '',
    accessToken: req.accessToken,
  });
  if (agent === null) {
    res.status(404).json(NO_THREAD);
    return null;
  }
  return agent;
}

function clamp(raw: unknown, fallback: number, max: number): number {
  return Math.min(Math.max(parseInt(String(raw), 10) || fallback, 1), max);
}

/**
 * A message as a thread page carries it.
 *
 * `conversationId` is what a client draws the seam from — where it changes, a
 * new stretch began — and `cursor` is the anchor for that exact message, which
 * is what makes a search hit jumpable.
 */
function toThreadMessage(row: ThreadMessageRow) {
  return {
    ...toStoredMessage(row),
    conversationId: row.threadConversationId,
    cursor: encodeThreadCursor({ at: row.createdAt, id: row.id }),
  };
}

/**
 * Open the thread: who the agent is, and which conversation to send to.
 *
 * `conversationId` is the ACTIVE stretch — the most recent conversation of the
 * pair, or a new one when the two have never spoken. It is not "the thread's
 * id", because a thread has none.
 */
router.get('/thread/:username', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const oxyUserId = req.user.id;

    const agent = await reachAgent(req, res);
    if (agent === null) return undefined;

    const active = await findActiveThreadConversation(getDb(), oxyUserId, agent._id);
    const conversation =
      active ??
      (await createConversation(getDb(), {
        oxyUserId,
        conversationId: randomUUID(),
        /**
         * `agentPromptName` rather than `agent.name`, which is nullable — a
         * conversation titled `null` is what an unresolvable Oxy account would
         * otherwise produce in the sidebar.
         */
        title: agentPromptName(agent),
        source: 'app',
        agentId: agent._id,
      }));

    res.json({
      /**
       * The agent, narrowed to what a thread header draws. Not the whole
       * record: `system_prompt`, `allowed_models` and the rest are
       * `GET /agents/:id`'s business, and a screen that only needs a name
       * should not be the reason a draft's prompt travels.
       */
      agent: {
        _id: agent._id,
        name: agent.name,
        handle: agent.handle,
        color: agent.color,
        tagline: agent.tagline,
        description: agent.description,
      },
      conversationId: conversation.conversationId,
    });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error resolving an agent thread');
    res.status(500).json({ error: 'Failed to open the thread' });
  }
});

/**
 * A page of the thread, oldest-first, crossing the seams.
 *
 * Two ways to ask, and they are different questions:
 *
 *  - `before=<cursor>` — strictly older than that point. What scrolling up
 *    sends, using the `nextCursor` of the page it already has.
 *  - `at=<cursor>` — the window CONTAINING that message, with context both
 *    sides. What a search hit opens. `before` cannot serve it: `before` is
 *    exclusive, so the hit itself would be the one message missing from the
 *    window meant to reveal it.
 *
 * Passing both is a 400 rather than a precedence rule nobody could guess.
 *
 * `nextCursor` is `null` when nothing older remains, decided by asking for one
 * row more than is returned. **Never by `messages.length < limit`**, which is
 * wrong at the exact boundary where the thread's length is a multiple of the
 * page size — the one case a reader reaches by scrolling.
 */
router.get('/thread/:username/messages', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const oxyUserId = req.user.id;

    const rawBefore = typeof req.query.before === 'string' ? req.query.before : undefined;
    const rawAt = typeof req.query.at === 'string' ? req.query.at : undefined;
    if (rawBefore !== undefined && rawAt !== undefined) {
      return res.status(400).json({ error: 'Send either before or at, not both' });
    }

    const cursor = rawBefore ?? rawAt;
    const decoded = cursor === undefined ? undefined : decodeThreadCursor(cursor);
    if (cursor !== undefined && decoded === null) {
      // Refused rather than ignored: silently serving the newest page for a
      // cursor the client believes in is an infinite scroll that never moves.
      return res.status(400).json({ error: 'Invalid cursor' });
    }

    const agent = await reachAgent(req, res);
    if (agent === null) return undefined;

    const limit = clamp(req.query.limit, DEFAULT_PAGE, MAX_PAGE);
    const page =
      rawAt !== undefined && decoded !== undefined && decoded !== null
        ? await listThreadWindow(getDb(), { oxyUserId, agentId: agent._id, limit, at: decoded })
        : await listThreadPage(getDb(), {
            oxyUserId,
            agentId: agent._id,
            limit,
            ...(decoded === undefined || decoded === null ? {} : { before: decoded }),
          });

    const oldest = page.messages[0];
    res.json({
      messages: page.messages.map(toThreadMessage),
      nextCursor:
        page.hasMore && oldest !== undefined
          ? encodeThreadCursor({ at: oldest.createdAt, id: oldest.id })
          : null,
    });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error reading an agent thread');
    res.status(500).json({ error: 'Failed to read the thread' });
  }
});

/**
 * Search everything said in the thread, across every conversation in it.
 *
 * Each hit carries a `cursor`, and that is the point of the endpoint rather
 * than a convenience: with only an id a client cannot ask for the page that
 * contains the message. The cursor goes to `?at=` above and returns the window
 * with the message in it, however many stretches back it lives.
 *
 * An empty query answers an empty list rather than everything. Every word must
 * be present — `websearch_to_tsquery` ANDs unquoted terms, measured — with
 * quoted phrases and `-` exclusion on top.
 */
router.get('/thread/:username/search', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const oxyUserId = req.user.id;

    const agent = await reachAgent(req, res);
    if (agent === null) return undefined;

    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (query === '') return res.json({ hits: [] });

    const hits = await searchThread(getDb(), {
      oxyUserId,
      agentId: agent._id,
      query,
      limit: clamp(req.query.limit, DEFAULT_HITS, MAX_HITS),
    });

    res.json({
      hits: hits.map((hit) => ({
        // The CLIENT's id where there is one — that is what a client holds for
        // a message. `toStoredMessage` records why `id` means that.
        messageId: hit.clientMessageId,
        conversationId: hit.conversationId,
        role: hit.role,
        snippet: hit.text,
        createdAt: hit.createdAt,
        cursor: encodeThreadCursor({ at: hit.createdAt, id: hit.id }),
      })),
    });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error searching an agent thread');
    res.status(500).json({ error: 'Failed to search the thread' });
  }
});

export default router;
