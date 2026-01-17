import { Router } from 'express';
import { randomUUID } from 'crypto';
import { Conversation } from '../models/conversation.js';
import { authenticateToken } from '../middleware/auth.js';
import type { Request, Response } from 'express';

const router = Router();

// Create a new empty conversation
router.post('/new', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const conversationId = randomUUID();

    const conversation = await Conversation.create({
      userId: req.user.id,
      conversationId,
      title: 'Nueva conversación',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date()
    });

    res.json({
      id: conversation.conversationId,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
  } catch (error) {
    console.error('Error creating conversation:', error);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// Get all conversations for the authenticated user
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const conversations = await Conversation.find({ userId: req.user.id })
      .select('conversationId title lastMessage createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .limit(100); // Limit to last 100 conversations

    res.json({
      conversations: conversations.map(c => ({
        id: c.conversationId,
        title: c.title,
        lastMessage: c.lastMessage,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      }))
    });
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// Get a specific conversation by ID
router.get('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const conversation = await Conversation.findOne({
      userId: req.user.id,
      conversationId: req.params.id
    });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({
      id: conversation.conversationId,
      title: conversation.title,
      lastMessage: conversation.lastMessage,
      messages: conversation.messages,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// Save or update a conversation
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { conversationId, title, messages } = req.body;

    if (!conversationId || !messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    // Generate lastMessage from the last message
    const lastMessage = messages.length > 0
      ? messages[messages.length - 1].content?.slice(0, 100)
      : undefined;

    // Find and update or create new conversation
    const conversation = await Conversation.findOneAndUpdate(
      {
        userId: req.user.id,
        conversationId
      },
      {
        title: title || messages.find((m: any) => m.role === 'user')?.content?.slice(0, 50) || 'Nueva conversación',
        lastMessage,
        messages,
        updatedAt: new Date()
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    );

    res.json({
      id: conversation.conversationId,
      title: conversation.title,
      lastMessage: conversation.lastMessage,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
  } catch (error) {
    console.error('Error saving conversation:', error);
    res.status(500).json({ error: 'Failed to save conversation' });
  }
});

// Delete a conversation
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await Conversation.deleteOne({
      userId: req.user.id,
      conversationId: req.params.id
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting conversation:', error);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

export default router;
