import { Router, Request, Response } from 'express';
import { errorMessage } from '../../shared/utils';
import type { AccountAdapter } from '../types';
import { sessionManager } from './session-manager';
import { WhatsAppChat, WhatsAppMessage } from './models';

export class WhatsAppAdapter implements AccountAdapter {
  name = 'whatsapp';

  async initialize() {
    await sessionManager.initialize();
  }

  async shutdown() {
    await sessionManager.shutdown();
  }

  getRouter(): Router {
    const router = Router();

    /**
     * POST /sessions/connect
     * Create a new session for a user. Returns sessionId, initial status, and QR code.
     *
     * Body: { oxyUserId: string }
     * Response: { sessionId, status, qr }
     */
    router.post('/sessions/connect', async (req: Request, res: Response) => {
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
          message: 'Scan the QR code with WhatsApp to connect',
        });
      } catch (error: unknown) {
        console.error('[Sessions] Connect error:', error);
        return res.status(500).json({ error: errorMessage(error) || 'Failed to create session' });
      }
    });

    /**
     * GET /sessions/:sessionId/qr
     * Returns the current QR code for a session that is awaiting scanning.
     */
    router.get('/sessions/:sessionId/qr', async (req: Request, res: Response) => {
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
      } catch (error: unknown) {
        console.error('[Sessions] QR fetch error:', error);
        return res.status(500).json({ error: errorMessage(error) || 'Failed to get QR code' });
      }
    });

    /**
     * GET /sessions/:sessionId/status
     * Returns the current connection status of a session.
     */
    router.get('/sessions/:sessionId/status', async (req: Request, res: Response) => {
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
          lastConnected: session.lastConnected || null,
          lastDisconnected: session.lastDisconnected || null,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        });
      } catch (error: unknown) {
        console.error('[Sessions] Status error:', error);
        return res.status(500).json({ error: errorMessage(error) || 'Failed to get status' });
      }
    });

    /**
     * POST /sessions/:sessionId/disconnect
     * Disconnects a specific WhatsApp session and clears auth data.
     */
    router.post('/sessions/:sessionId/disconnect', async (req: Request, res: Response) => {
      const { sessionId } = req.params;

      try {
        await sessionManager.disconnectSession(sessionId);
        return res.json({
          status: 'logged-out',
          message: 'Session disconnected successfully',
        });
      } catch (error: unknown) {
        console.error('[Sessions] Disconnect error:', error);
        return res.status(500).json({ error: errorMessage(error) || 'Failed to disconnect session' });
      }
    });

    /**
     * GET /sessions/user/:userId
     * List all sessions for a specific user.
     */
    router.get('/sessions/user/:userId', async (req: Request, res: Response) => {
      const { userId } = req.params;

      try {
        const sessions = await sessionManager.getUserSessions(userId);
        return res.json({ sessions });
      } catch (error: unknown) {
        console.error('[Sessions] User sessions error:', error);
        return res.status(500).json({ error: errorMessage(error) || 'Failed to get user sessions' });
      }
    });

    /**
     * GET /sessions
     * Admin endpoint: list all sessions.
     */
    router.get('/sessions', async (_req: Request, res: Response) => {
      try {
        const sessions = await sessionManager.listSessions();
        return res.json({ sessions });
      } catch (error: unknown) {
        console.error('[Sessions] List error:', error);
        return res.status(500).json({ error: errorMessage(error) || 'Failed to list sessions' });
      }
    });

    /**
     * GET /sessions/:sessionId/chats
     * Returns the session's recent WhatsApp chats from MongoDB.
     */
    router.get('/sessions/:sessionId/chats', async (req: Request, res: Response) => {
      const { sessionId } = req.params;

      try {
        const dbChats = await WhatsAppChat.find({ sessionId })
          .sort({ conversationTimestamp: -1 })
          .limit(50)
          .lean();

        // Enrich with last message preview from MongoDB
        const chats = await Promise.all(
          dbChats.map(async (c) => {
            const lastMsg = await WhatsAppMessage.findOne({ sessionId, jid: c.jid })
              .sort({ timestamp: -1 })
              .lean();

            return {
              jid: c.jid,
              name: c.name || c.jid.split('@')[0],
              unreadCount: c.unreadCount || 0,
              lastMessageTimestamp: c.conversationTimestamp || null,
              lastMessagePreview: lastMsg?.text?.slice(0, 100) || '',
            };
          })
        );

        return res.json({ chats });
      } catch (error: unknown) {
        console.error('[Sessions] Chats error:', error);
        return res.status(500).json({ error: errorMessage(error) || 'Failed to get chats' });
      }
    });

    /**
     * GET /sessions/:sessionId/chats/:jid/messages
     * Returns recent messages from a specific chat (from MongoDB).
     * Query: ?limit=20 (default 20, max 50)
     */
    router.get('/sessions/:sessionId/chats/:jid/messages', async (req: Request, res: Response) => {
      const { sessionId, jid } = req.params;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

      try {
        const messages = await WhatsAppMessage.find({ sessionId, jid })
          .sort({ timestamp: -1 })
          .limit(limit)
          .lean();

        return res.json({
          messages: messages.map((m) => ({
            id: m.messageId,
            fromMe: m.fromMe,
            timestamp: m.timestamp,
            text: m.text,
            pushName: m.pushName || null,
          })),
        });
      } catch (error: unknown) {
        console.error('[Sessions] Messages error:', error);
        return res.status(500).json({ error: errorMessage(error) || 'Failed to get messages' });
      }
    });

    /**
     * POST /sessions/:sessionId/send
     * Send a message to a specific JID via a specific session.
     * Body: { jid: string, text: string }
     */
    router.post('/sessions/:sessionId/send', async (req: Request, res: Response) => {
      const { sessionId } = req.params;
      const { jid, text } = req.body;

      if (!jid || !text) {
        return res.status(400).json({ error: 'jid and text are required' });
      }

      try {
        const sock = sessionManager.getSocket(sessionId);
        if (!sock) {
          return res.status(404).json({ error: 'No active session found' });
        }

        const result = await sock.sendMessage(jid, { text });
        return res.json({ success: true, messageId: result?.key?.id });
      } catch (error: unknown) {
        console.error('[Sessions] Send error:', error);
        return res.status(500).json({ error: errorMessage(error) || 'Failed to send message' });
      }
    });

    return router;
  }
}
