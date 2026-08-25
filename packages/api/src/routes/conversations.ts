import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { storedMediaUrl } from '../lib/stored-media.js';
import {
  conversationExists,
  createConversation,
  deleteConversation,
  findConversation,
  listConversations,
  upsertConversation,
} from '../db/chat/conversationRepository.js';
import {
  deleteConversationBreaks,
  insertConversationBreak,
  listConversationBreaks,
} from '../db/chat/conversationBreakRepository.js';
import {
  deleteMessages,
  listMessages,
  replaceMessages,
  searchMessages,
  toStoredMessage,
  voteMessage,
  type NewMessage,
} from '../db/chat/messageRepository.js';
import {
  CONVERSATION_SOURCES,
  MESSAGE_ROLES,
  MESSAGE_VOTES,
  TOOL_INVOCATION_STATES,
  type AgentInfo,
  type ConversationSource,
  type MessageContent,
  type MessageRole,
  type MessageVote,
  type ToolInvocation,
} from '../domain/conversation.js';
import { authenticateToken, authenticateTokenOrApiKey } from '../middleware/auth.js';
import type { Request, Response } from 'express';
import { log } from '../lib/logger.js';

const router = Router();

/** The largest page `GET /` will serve, whatever the caller asks for. */
const MAX_PAGE = 50;
const DEFAULT_PAGE = 20;

/**
 * The whitelist for a message arriving in `POST /` — the ONLY place a client
 * supplies a stored message.
 *
 * ## Why this is a function and not a spread
 *
 * The Mongoose schema was the whitelist: unknown keys were stripped, `state` was
 * checked against its `enum`, and `agentInfo` was cast to its sub-schema.
 * `content` and `tool_invocations` are `jsonb` now and enforce nothing, so a
 * `{ ...m }` here would store whatever the client sent under whatever names it
 * chose — including `seq`, `oxyUserId` and `vote`, which decide ordering,
 * ownership and somebody's feedback signal.
 *
 * `seq` is deliberately NOT taken from the body: `replaceMessages` assigns it
 * from the array index, which is what makes the stored order the client's order.
 */
function messageFromBody(body: unknown): Omit<NewMessage, 'conversationId' | 'oxyUserId' | 'seq'> | null {
  if (body === null || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  const role = raw.role;
  const content = raw.content;
  if (typeof role !== 'string' || !(MESSAGE_ROLES as readonly string[]).includes(role)) return null;
  if (content === undefined || !isMessageContent(content)) return null;

  return {
    role: role as MessageRole,
    content,
    ...(typeof raw.id === 'string' ? { clientMessageId: raw.id } : {}),
    ...(toolInvocationsFromBody(raw.toolInvocations) ?? {}),
    ...(agentInfoFromBody(raw.agentInfo) ?? {}),
    ...(createdAtFromBody(raw.createdAt) ?? {}),
  };
}

/** A body's `content`: a string, or the AI SDK's ordered parts array. */
function isMessageContent(value: unknown): value is MessageContent {
  if (typeof value === 'string') return true;
  return (
    Array.isArray(value) &&
    value.every(
      (part) =>
        part !== null && typeof part === 'object' && typeof (part as { type: unknown }).type === 'string',
    )
  );
}

/**
 * The five fields a tool invocation may carry, with `state` checked.
 *
 * An element that is not recognisably one is dropped rather than failing the
 * request, which is what Mongoose's cast did to a malformed sub-document.
 */
function toolInvocationsFromBody(value: unknown): { toolInvocations: ToolInvocation[] } | null {
  if (!Array.isArray(value)) return null;
  const invocations = value.flatMap((element): ToolInvocation[] => {
    if (element === null || typeof element !== 'object') return [];
    const raw = element as Record<string, unknown>;
    if (typeof raw.toolCallId !== 'string' || typeof raw.toolName !== 'string') return [];
    if (typeof raw.state !== 'string' || !(TOOL_INVOCATION_STATES as readonly string[]).includes(raw.state)) {
      return [];
    }
    return [
      {
        toolCallId: raw.toolCallId,
        toolName: raw.toolName,
        state: raw.state,
        ...(raw.args === undefined ? {} : { args: raw.args }),
        ...(raw.result === undefined ? {} : { result: raw.result }),
      },
    ];
  });
  return { toolInvocations: invocations };
}

/** `agent_info`'s four columns, or nothing. Partial sub-documents are dropped. */
function agentInfoFromBody(value: unknown): { agentInfo: AgentInfo } | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.handle !== 'string') {
    return null;
  }
  return {
    agentInfo: {
      id: raw.id,
      name: raw.name,
      color: typeof raw.color === 'string' ? raw.color : null,
      handle: raw.handle,
    },
  };
}

/**
 * A client-supplied `createdAt`, when it is a usable instant.
 *
 * Mongoose cast the string and threw a CastError on anything else, failing the
 * whole save with a 500. Falling back to the column default instead is the one
 * deliberate softening in this route: a client sending a malformed timestamp
 * would otherwise lose the conversation it was trying to save, and no shipped
 * client sends the field at all — `packages/app/lib/hooks/use-conversations.ts`
 * declares no `createdAt` on `Message`.
 */
function createdAtFromBody(value: unknown): { createdAt: Date } | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : { createdAt: parsed };
}

/** The first 100 characters of a message body, for the thread preview. */
function preview(content: MessageContent): string | undefined {
  if (typeof content !== 'string') return undefined;
  return content.slice(0, 100);
}

/**
 * A `source` the schema's CHECK will accept, or `undefined`.
 *
 * An unrecognised value is IGNORED rather than stored. `Conversation.create`
 * ran Mongoose validators, so the source's answer to `source: 'carrier-pigeon'`
 * was a 500 for the whole request; the column's CHECK would answer the same way
 * and less legibly. No shipped client sends anything but `app` here, so the
 * fallback affects nothing that exists — but it is a change, and it is in the
 * direction of the request succeeding with a slightly less precise label rather
 * than failing.
 */
function sourceFromBody(value: unknown): ConversationSource | undefined {
  return typeof value === 'string' && (CONVERSATION_SOURCES as readonly string[]).includes(value)
    ? (value as ConversationSource)
    : undefined;
}

// Create a new empty conversation
router.post('/new', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const conversationId = randomUUID();
    /**
     * Any string. Mongoose cast this to an ObjectId and threw on anything else;
     * `agent_id` is `text` with no foreign key (`db/schema/chat.ts` says why), so
     * there is nothing left to cast against. An id naming no agent is inert —
     * the only reader joins on it — and rejecting one here would be a new
     * validation rather than a ported one.
     */
    const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId : undefined;

    const conversation = await createConversation(getDb(), {
      oxyUserId: req.user.id,
      conversationId,
      title: 'New chat',
      source: sourceFromBody(req.body?.source) ?? 'app',
      ...(agentId === undefined ? {} : { agentId }),
    });

    res.json({
      id: conversation.conversationId,
      title: conversation.title,
      source: conversation.source,
      agentId: conversation.agentId,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error creating conversation');
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// Get all conversations for the authenticated user with cursor-based pagination
router.get('/', authenticateTokenOrApiKey, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    /**
     * Clamped at BOTH ends. Mongo read a negative `limit` as "this many, one
     * batch"; Postgres refuses it outright, so an unclamped `?limit=-5` would
     * turn a working request into a 500.
     */
    const limit = Math.min(
      Math.max(parseInt(req.query.limit as string) || DEFAULT_PAGE, 1),
      MAX_PAGE,
    );
    const cursor = req.query.cursor as string | undefined;
    const before = cursor ? new Date(cursor) : undefined;
    /**
     * An unparseable cursor is refused rather than ignored. Mongo compared
     * against an Invalid Date and matched nothing, so the page came back empty;
     * `lt(updated_at, 'Invalid Date')` does not survive parameter binding at
     * all, and answering 400 says what happened instead of failing the whole
     * request with a 500.
     */
    if (before !== undefined && Number.isNaN(before.getTime())) {
      return res.status(400).json({ error: 'Invalid cursor' });
    }

    // One extra row decides `hasMore` without a second count query.
    const rows = await listConversations(getDb(), req.user.id, limit + 1, before);

    const hasMore = rows.length > limit;
    const results = hasMore ? rows.slice(0, limit) : rows;

    const nextCursor =
      hasMore && results.length > 0 ? results[results.length - 1].updatedAt.toISOString() : null;

    res.json({
      conversations: results.map((c) => ({
        id: c.conversationId,
        title: c.title,
        lastMessage: c.lastMessage,
        source: c.source,
        agentId: c.agentId,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
      nextCursor,
      hasMore,
    });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error fetching conversations');
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// Get a specific conversation by ID
router.get('/:id', authenticateTokenOrApiKey, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = req.user.id;

    const conversationId = String(req.params.id);
    const conversation = await findConversation(getDb(), userId, conversationId);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    /**
     * The breaks come back BESIDE the messages, not merged into them.
     *
     * Merging is the client's, by timestamp, because a break is not a message
     * and must never be one: `db/schema/chat.ts` records what a `separator`
     * role would have cost. The two reads are concurrent because neither
     * depends on the other.
     */
    const [rows, breaks] = await Promise.all([
      listMessages(getDb(), userId, conversationId),
      listConversationBreaks(getDb(), userId, conversationId),
    ]);

    res.json({
      id: conversation.conversationId,
      title: conversation.title,
      lastMessage: conversation.lastMessage,
      source: conversation.source,
      agentId: conversation.agentId,
      /**
       * `audioUrl` is a stored KEY, and a key is not an address.
       *
       * This is where the read-aloud 403 came from: the speech endpoint was
       * corrected on its own, and a message loaded with its conversation went
       * on handing the player the storage address until it stopped being one.
       * A message whose audio cannot be addressed drops the field rather than
       * carrying something unfetchable.
       */
      messages: rows.map(toStoredMessage).map((message) => {
        if (message.audioUrl === undefined) return message;
        const link = storedMediaUrl(req, message.audioUrl, userId);
        const { audioUrl: _stored, ...rest } = message;
        return link === null ? rest : { ...rest, audioUrl: link };
      }),
      /**
       * Instants, not rendered rules. A DATE separator is derived from these
       * and from `createdAt` on each message by the client, which is the only
       * party that knows the reader's timezone — storing one would be storing a
       * rendering decision, wrong for anybody reading from another zone.
       */
      breaks: breaks.map((at) => at.toISOString()),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error fetching conversation');
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// Save or update a conversation
router.post('/', authenticateTokenOrApiKey, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { conversationId, title, messages, source } = req.body;

    if (!conversationId || typeof conversationId !== 'string' || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    // Anything that is not recognisably a message is dropped, as before.
    const validMessages = messages.flatMap((message: unknown) => {
      const whitelisted = messageFromBody(message);
      return whitelisted === null ? [] : [whitelisted];
    });

    const last = validMessages[validMessages.length - 1];
    const lastMessage = last === undefined ? undefined : preview(last.content);

    /**
     * The title is only overwritten when the caller asked for it. Without an
     * explicit one an existing thread keeps its title, and a new thread falls
     * back to the first user message — which is the `$setOnInsert` branch.
     */
    const firstUser = validMessages.find((message) => message.role === 'user');
    const titleOnInsert =
      (typeof firstUser?.content === 'string' ? firstUser.content.slice(0, 50) : '') || 'New chat';

    /**
     * The conversation and its messages are written CONCURRENTLY, as the source
     * did. `db/schema/chat.ts` refuses the foreign key that would make this a
     * race-dependent `23503`, and names this statement as the reason.
     */
    const onInsertSource = sourceFromBody(source);
    const [conversation] = await Promise.all([
      upsertConversation(getDb(), {
        oxyUserId: req.user.id,
        conversationId,
        ...(lastMessage === undefined ? {} : { lastMessage }),
        ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
        titleOnInsert,
        ...(onInsertSource === undefined ? {} : { source: onInsertSource }),
      }),
      replaceMessages(getDb(), req.user.id, conversationId, validMessages),
    ]);

    res.json({
      id: conversation.conversationId,
      title: conversation.title,
      lastMessage: conversation.lastMessage,
      source: conversation.source,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error saving conversation');
    res.status(500).json({ error: 'Failed to save conversation' });
  }
});

// Vote on a message (thumbs up/down)
router.patch(
  '/:id/messages/:messageId/vote',
  authenticateToken,
  async (req: Request<{ id: string; messageId: string }>, res: Response) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { vote } = req.body;
      if (vote !== null && !(MESSAGE_VOTES as readonly string[]).includes(vote)) {
        return res.status(400).json({ error: 'vote must be "up", "down", or null' });
      }

      const result = await voteMessage(
        getDb(),
        req.user.id,
        String(req.params.id),
        String(req.params.messageId),
        vote as MessageVote | null,
      );

      if (!result) {
        return res.status(404).json({ error: 'Message not found' });
      }

      res.json({ success: true, vote: result.vote ?? null });
    } catch (error: unknown) {
      log.chat.error({ err: error }, 'Error voting on message');
      res.status(500).json({ error: 'Failed to vote on message' });
    }
  },
);

/** The most hits one search answers with, whatever the caller asks for. */
const MAX_SEARCH_HITS = 50;
const DEFAULT_SEARCH_HITS = 20;

/**
 * Search what was said in one thread.
 *
 * A permanent thread with an agent outgrows scrolling, so this is the second of
 * the three ways back to something old — after scrolling and beside the agent's
 * own recall, which reads the SAME index through the same query
 * (`searchMessages`). One definition of what counts as text, not two.
 *
 * Scoped to a thread the CALLER holds, so searching somebody else's thread is a
 * 404 rather than a 403, exactly as reading it already is.
 *
 * Every word in the query has to be present — `websearch_to_tsquery` ANDs
 * unquoted terms, which is what a search box does — with quoted phrases and `-`
 * exclusion on top. `db/chat/messageRepository.ts` records that this was
 * measured rather than assumed.
 *
 * An empty query answers an empty list rather than everything. `websearch_to_tsquery`
 * turns whitespace into an empty tsquery, which matches nothing — but returning
 * early says so rather than leaving it to a coincidence of that function's
 * behaviour.
 */
router.get('/:id/search', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = req.user.id;
    const conversationId = String(req.params.id);

    if (!(await conversationExists(getDb(), userId, conversationId))) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (query === '') return res.json({ results: [] });

    const limit = Math.min(
      Math.max(parseInt(req.query.limit as string, 10) || DEFAULT_SEARCH_HITS, 1),
      MAX_SEARCH_HITS,
    );

    const hits = await searchMessages(getDb(), userId, conversationId, query, limit);

    res.json({
      results: hits.map((hit) => ({
        // The CLIENT's id, which is what a result has to carry: it is the one a
        // client can scroll to. See `toStoredMessage` for why `id` means that.
        id: hit.clientMessageId,
        role: hit.role,
        text: hit.text,
        createdAt: hit.createdAt,
      })),
    });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error searching a conversation');
    res.status(500).json({ error: 'Failed to search this conversation' });
  }
});

/**
 * Start a new conversation inside a thread.
 *
 * `/a/:username` never ends, so this is how a person says "what follows is a
 * new subject" without losing what came before. It answers the instant rather
 * than the row, because the instant is all the client merges on.
 *
 * Scoped to a thread the CALLER holds: `findConversation` puts the owner in the
 * WHERE, so marking a break in somebody else's thread is a 404 rather than a
 * 403, exactly as reading it already is.
 *
 * Deliberately not idempotent and deliberately unlimited. Two marks a second
 * apart are two marks; the client draws one rule per mark and the person who
 * pressed the button twice sees what they did. A dedupe window here would be a
 * rule invented in the API for a gesture the UI already controls.
 */
router.post('/:id/break', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = req.user.id;
    const conversationId = String(req.params.id);

    if (!(await conversationExists(getDb(), userId, conversationId))) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const createdAt = await insertConversationBreak(getDb(), userId, conversationId);
    res.status(201).json({ createdAt: createdAt.toISOString() });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error marking a conversation break');
    res.status(500).json({ error: 'Failed to start a new conversation' });
  }
});

// Delete a conversation
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    /**
     * All three statements, concurrently, exactly as the source ran the first
     * two. There is no cascade to lean on — `db/schema/chat.ts` refuses the
     * foreign key — so the children are removed here or not at all, and they
     * are removed even when no conversation row matched, which is how orphans
     * left by an earlier failure get cleared.
     *
     * `conversation_breaks` joins that list for the same reason `messages` is
     * in it: a new child table with no foreign key is a new thing to leak, and
     * this is the only place a thread is deleted.
     */
    const conversationId = String(req.params.id);
    const [removed] = await Promise.all([
      deleteConversation(getDb(), req.user.id, conversationId),
      deleteMessages(getDb(), req.user.id, conversationId),
      deleteConversationBreaks(getDb(), req.user.id, conversationId),
    ]);

    if (removed === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({ success: true });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error deleting conversation');
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

export default router;
