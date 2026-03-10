import { Router } from 'express';
import { randomUUID } from 'crypto';
import { Conversation } from '../models/conversation.js';
import { Message } from '../models/message.js';
import { authenticateToken, authenticateTokenOrApiKey } from '../middleware/auth.js';
import type { Request, Response } from 'express';
import { log } from '../lib/logger.js';

const router = Router();

// Create a new empty conversation
router.post('/new', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const conversationId = randomUUID();
    const { source = 'app', agentId } = req.body;

    const conversation = await Conversation.create({
      oxyUserId: req.user.id,
      conversationId,
      title: 'New chat',
      source,
      ...(agentId && { agentId }),
    });

    res.json({
      id: conversation.conversationId,
      title: conversation.title,
      source: conversation.source,
      agentId: conversation.agentId,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
  } catch (error) {
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

    // Pagination parameters
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50); // Max 50 per request
    const cursor = req.query.cursor as string | undefined; // ISO date string

    // Build query
    const query: any = { oxyUserId: req.user.id };

    // If cursor provided, only get conversations older than cursor
    if (cursor) {
      query.updatedAt = { $lt: new Date(cursor) };
    }

    const conversations = await Conversation.find(query)
      .select('conversationId title lastMessage source agentId createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .limit(limit + 1); // Fetch one extra to determine if there are more

    // Check if there are more results
    const hasMore = conversations.length > limit;
    const results = hasMore ? conversations.slice(0, limit) : conversations;

    // Next cursor is the updatedAt of the last conversation
    const nextCursor = hasMore && results.length > 0
      ? results[results.length - 1].updatedAt.toISOString()
      : null;

    res.json({
      conversations: results.map(c => ({
        id: c.conversationId,
        title: c.title,
        lastMessage: c.lastMessage,
        source: c.source || 'app',
        agentId: c.agentId,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      })),
      nextCursor,
      hasMore
    });
  } catch (error) {
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

    const conversation = await Conversation.findOne({
      oxyUserId: req.user.id,
      conversationId: req.params.id
    });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Load messages from separate collection
    const messages = await Message.find({
      conversationId: req.params.id,
      oxyUserId: req.user.id,
    })
      .sort({ createdAt: 1 })
      .lean();

    res.json({
      id: conversation.conversationId,
      title: conversation.title,
      lastMessage: conversation.lastMessage,
      source: conversation.source || 'app',
      agentId: conversation.agentId,
      messages,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
  } catch (error) {
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

    if (!conversationId || !messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    // Filter out any invalid messages before saving
    const validMessages = messages.filter((msg: any) =>
      msg != null && msg.role && msg.content !== undefined
    );

    // Generate lastMessage from the last valid message
    const lastMessage = validMessages.length > 0
      ? validMessages[validMessages.length - 1].content?.slice(0, 100)
      : undefined;

    // Build update object for conversation metadata
    const updateData: Record<string, any> = { lastMessage };

    // Only overwrite title if explicitly provided (e.g. user rename)
    if (title) {
      updateData.title = title;
    }

    // Only set source on insert (don't change source of existing conversations)
    const setOnInsert: Record<string, any> = {};
    if (source) {
      setOnInsert.source = source;
    }
    // Fallback title only on first insert when no explicit title given
    if (!title) {
      setOnInsert.title = validMessages.find((m: any) => m.role === 'user')?.content?.slice(0, 50) || 'New chat';
    }

    // Update conversation metadata and replace messages atomically
    const [conversation] = await Promise.all([
      Conversation.findOneAndUpdate(
        { oxyUserId: req.user.id, conversationId },
        { $set: updateData, $setOnInsert: setOnInsert },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
      ),
      // Replace all messages for this conversation
      Message.deleteMany({ conversationId, oxyUserId: req.user.id }).then(async () => {
        if (validMessages.length > 0) {
          await Message.insertMany(
            validMessages.map((m: any) => ({
              conversationId,
              oxyUserId: req.user!.id,
              id: m.id,
              role: m.role,
              content: m.content,
              vote: m.vote,
              toolInvocations: m.toolInvocations,
              agentInfo: m.agentInfo,
              audioUrl: m.audioUrl,
              createdAt: m.createdAt || new Date(),
            })),
            { ordered: false }
          );
        }
      }),
    ]);

    res.json({
      id: conversation.conversationId,
      title: conversation.title,
      lastMessage: conversation.lastMessage,
      source: conversation.source || 'app',
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
  } catch (error) {
    log.chat.error({ err: error }, 'Error saving conversation');
    res.status(500).json({ error: 'Failed to save conversation' });
  }
});

// Delete a conversation
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const [result] = await Promise.all([
      Conversation.deleteOne({
        oxyUserId: req.user.id,
        conversationId: req.params.id
      }),
      Message.deleteMany({
        oxyUserId: req.user.id,
        conversationId: req.params.id
      }),
    ]);

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({ success: true });
  } catch (error) {
    log.chat.error({ err: error }, 'Error deleting conversation');
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

export default router;
