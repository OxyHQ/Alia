import { Router, Request, Response } from 'express';
import { sessionManager } from '../session-manager';
import { TelegramChat } from '../models/telegram-chat';
import { TelegramMessage } from '../models/telegram-message';

const router = Router();

/**
 * Middleware: authenticate all session routes with TELEGRAM_GATEWAY_SECRET.
 */
router.use((req: Request, res: Response, next) => {
  const secret = req.headers['x-gateway-secret'] || req.headers['x-channel-bot-secret'];
  const expected = process.env.TELEGRAM_GATEWAY_SECRET;

  if (!expected) {
    return res.status(500).json({ error: 'TELEGRAM_GATEWAY_SECRET not configured on server' });
  }

  if (secret !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
});

/**
 * POST /sessions/connect
 * Create a new session for a user. Returns initial status and begins QR generation.
 *
 * Body: { oxyUserId: string }
 * Response: { sessionId, status, qr? }
 */
router.post('/connect', async (req: Request, res: Response) => {
  const { oxyUserId } = req.body;

  if (!oxyUserId) {
    return res.status(400).json({ error: 'oxyUserId is required' });
  }

  try {
    // Create a new session and wait for the first QR code
    const { sessionId, qrPromise } = await sessionManager.createSession(oxyUserId);

    // Wait for the QR code to be generated (with timeout)
    const qr = await qrPromise;

    return res.json({
      sessionId,
      status: 'qr-pending',
      qr,
      message: 'Scan the QR code with Telegram to connect',
    });
  } catch (error: any) {
    console.error('[Sessions] Connect error:', error);
    return res.status(500).json({ error: error.message || 'Failed to create session' });
  }
});

/**
 * GET /sessions/:sessionId/qr
 * Returns the current QR code for a session that is awaiting scanning.
 */
router.get('/:sessionId/qr', async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  try {
    const session = await sessionManager.getStatus(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'connected') {
      return res.json({
        status: 'connected',
        phoneNumber: session.phoneNumber,
        displayName: session.displayName,
        message: 'Already connected, no QR needed',
      });
    }

    if (!session.lastQR) {
      return res.json({
        status: session.status,
        qr: null,
        message: 'QR code not yet generated or expired',
      });
    }

    return res.json({
      status: session.status,
      qr: session.lastQR,
    });
  } catch (error: any) {
    console.error('[Sessions] QR fetch error:', error);
    return res.status(500).json({ error: error.message || 'Failed to get QR code' });
  }
});

/**
 * GET /sessions/:sessionId/status
 * Returns the current connection status of a session.
 */
router.get('/:sessionId/status', async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  try {
    const session = await sessionManager.getStatus(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    return res.json({
      sessionId: session.sessionId,
      oxyUserId: session.oxyUserId,
      telegramUserId: session.telegramUserId || null,
      status: session.status,
      phoneNumber: session.phoneNumber || null,
      displayName: session.displayName || null,
      lastConnected: session.lastConnected || null,
      lastDisconnected: session.lastDisconnected || null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
  } catch (error: any) {
    console.error('[Sessions] Status error:', error);
    return res.status(500).json({ error: error.message || 'Failed to get status' });
  }
});

/**
 * POST /sessions/:sessionId/disconnect
 * Disconnects a Telegram session and clears session string.
 */
router.post('/:sessionId/disconnect', async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  try {
    await sessionManager.disconnectSession(sessionId);
    return res.json({
      status: 'logged-out',
      message: 'Session disconnected successfully',
    });
  } catch (error: any) {
    console.error('[Sessions] Disconnect error:', error);
    return res.status(500).json({ error: error.message || 'Failed to disconnect session' });
  }
});

/**
 * GET /sessions/user/:userId
 * Returns all sessions for a given oxyUserId (multi-account support).
 */
router.get('/user/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params;

  try {
    const sessions = await sessionManager.getUserSessions(userId);
    return res.json({ sessions });
  } catch (error: any) {
    console.error('[Sessions] User sessions error:', error);
    return res.status(500).json({ error: error.message || 'Failed to get user sessions' });
  }
});

/**
 * GET /sessions
 * Admin endpoint: list all sessions.
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const sessions = await sessionManager.listSessions();
    return res.json({ sessions });
  } catch (error: any) {
    console.error('[Sessions] List error:', error);
    return res.status(500).json({ error: error.message || 'Failed to list sessions' });
  }
});

/**
 * GET /sessions/:sessionId/chats
 * Returns the session's recent Telegram chats from MongoDB.
 */
router.get('/:sessionId/chats', async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  try {
    const dbChats = await TelegramChat.find({ sessionId })
      .sort({ lastMessageTimestamp: -1 })
      .limit(50)
      .lean();

    // Enrich with last message preview from MongoDB
    const chats = await Promise.all(
      dbChats.map(async (c) => {
        const lastMsg = await TelegramMessage.findOne({ sessionId, chatId: c.chatId })
          .sort({ timestamp: -1 })
          .lean();

        return {
          chatId: c.chatId,
          name: c.name || c.chatId,
          chatType: c.chatType,
          unreadCount: c.unreadCount || 0,
          lastMessageTimestamp: c.lastMessageTimestamp || null,
          lastMessagePreview: lastMsg?.text?.slice(0, 100) || '',
        };
      })
    );

    return res.json({ chats });
  } catch (error: any) {
    console.error('[Sessions] Chats error:', error);
    return res.status(500).json({ error: error.message || 'Failed to get chats' });
  }
});

/**
 * GET /sessions/:sessionId/chats/:chatId/messages
 * Returns recent messages from a specific chat (from MongoDB).
 * Query: ?limit=20 (default 20, max 50)
 */
router.get('/:sessionId/chats/:chatId/messages', async (req: Request, res: Response) => {
  const { sessionId, chatId } = req.params;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

  try {
    const messages = await TelegramMessage.find({ sessionId, chatId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    return res.json({
      messages: messages.map((m) => ({
        id: m.messageId,
        fromMe: m.fromMe,
        timestamp: m.timestamp,
        text: m.text,
        senderName: m.senderName || null,
      })),
    });
  } catch (error: any) {
    console.error('[Sessions] Messages error:', error);
    return res.status(500).json({ error: error.message || 'Failed to get messages' });
  }
});

/**
 * POST /sessions/:sessionId/send
 * Send a message to a specific chatId.
 * Body: { chatId: string, text: string }
 */
router.post('/:sessionId/send', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const { chatId, text } = req.body;

  if (!chatId || !text) {
    return res.status(400).json({ error: 'chatId and text are required' });
  }

  try {
    const client = sessionManager.getSocket(sessionId);
    if (!client) {
      return res.status(404).json({ error: 'No active session found' });
    }

    const result = await client.sendMessage(chatId, { message: text });
    return res.json({ success: true, messageId: result?.id?.toString() });
  } catch (error: any) {
    console.error('[Sessions] Send error:', error);
    return res.status(500).json({ error: error.message || 'Failed to send message' });
  }
});

export default router;
