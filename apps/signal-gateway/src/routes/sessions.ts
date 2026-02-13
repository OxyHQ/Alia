import { Router, Request, Response } from 'express';
import { sessionManager } from '../session-manager';
import { SignalChat } from '../models/signal-chat';
import { SignalMessage } from '../models/signal-message';

const router = Router();

/**
 * Middleware: authenticate all session routes with SIGNAL_GATEWAY_SECRET.
 */
router.use((req: Request, res: Response, next) => {
  const secret = req.headers['x-gateway-secret'] || req.headers['x-channel-bot-secret'];
  const expected = process.env.SIGNAL_GATEWAY_SECRET;

  if (!expected) {
    return res.status(500).json({ error: 'SIGNAL_GATEWAY_SECRET not configured on server' });
  }

  if (secret !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
});

/**
 * POST /sessions/link
 * Start linking a new Signal device for a user.
 * Returns sessionId and the sgnl:// QR URI once available.
 *
 * Body: { oxyUserId: string }
 * Response: { sessionId, status, qr }
 */
router.post('/link', async (req: Request, res: Response) => {
  const { oxyUserId } = req.body;

  if (!oxyUserId) {
    return res.status(400).json({ error: 'oxyUserId is required' });
  }

  try {
    const { sessionId, qrPromise } = await sessionManager.linkDevice(oxyUserId);

    // Wait for the QR URI to be generated (with timeout)
    const qr = await qrPromise;

    return res.json({
      sessionId,
      status: 'linking',
      qr,
      message: 'Scan the QR code with Signal to link this device',
    });
  } catch (error: any) {
    console.error('[Sessions] Link error:', error);
    return res.status(500).json({ error: error.message || 'Failed to start linking' });
  }
});

/**
 * GET /sessions/:sessionId/qr
 * Returns the current QR URI for a session that is awaiting scanning.
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
      sessionId: session.sessionId,
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
      status: session.status,
      phoneNumber: session.phoneNumber || null,
      displayName: session.displayName || null,
      daemonPort: session.daemonPort || null,
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
 * POST /sessions/:sessionId/unlink
 * Unlinks a Signal device, kills daemon, and removes data.
 */
router.post('/:sessionId/unlink', async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  try {
    await sessionManager.unlinkDevice(sessionId);
    return res.json({
      status: 'unlinked',
      message: 'Session unlinked successfully',
    });
  } catch (error: any) {
    console.error('[Sessions] Unlink error:', error);
    return res.status(500).json({ error: error.message || 'Failed to unlink session' });
  }
});

/**
 * GET /sessions/user/:userId
 * List all sessions for a specific user.
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
 * Returns the session's recent Signal chats from MongoDB.
 */
router.get('/:sessionId/chats', async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  try {
    const dbChats = await SignalChat.find({ sessionId })
      .sort({ lastMessageTimestamp: -1 })
      .limit(50)
      .lean();

    // Enrich with last message preview from MongoDB
    const chats = await Promise.all(
      dbChats.map(async (c) => {
        const lastMsg = await SignalMessage.findOne({ sessionId, contactId: c.contactId })
          .sort({ timestamp: -1 })
          .lean();

        return {
          contactId: c.contactId,
          name: c.name || c.contactId,
          unreadCount: c.unreadCount || 0,
          chatType: c.chatType || 'direct',
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
 * GET /sessions/:sessionId/chats/:contactId/messages
 * Returns recent messages from a specific chat (from MongoDB).
 * Query: ?limit=20 (default 20, max 50)
 */
router.get('/:sessionId/chats/:contactId/messages', async (req: Request, res: Response) => {
  const { sessionId, contactId } = req.params;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

  try {
    const messages = await SignalMessage.find({ sessionId, contactId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    return res.json({
      messages: messages.map((m) => ({
        messageTimestamp: m.messageTimestamp,
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
 * Send a message to a specific contact via signal-cli daemon.
 * Body: { contactId: string, text: string }
 */
router.post('/:sessionId/send', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const { contactId, text } = req.body;

  if (!contactId || !text) {
    return res.status(400).json({ error: 'contactId and text are required' });
  }

  try {
    const session = await sessionManager.getStatus(sessionId);
    if (!session?.daemonPort) {
      return res.status(404).json({ error: 'No active daemon for this session' });
    }

    const response = await fetch(`http://127.0.0.1:${session.daemonPort}/api/v1/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipients: [contactId],
        message: text,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(502).json({ error: `signal-cli error: ${errorText}` });
    }

    const result = await response.json();
    return res.json({ success: true, result });
  } catch (error: any) {
    console.error('[Sessions] Send error:', error);
    return res.status(500).json({ error: error.message || 'Failed to send message' });
  }
});

export default router;
