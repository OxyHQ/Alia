import { Router, Request, Response } from 'express';
import type { MessagingAdapter } from '../types';
import { sessionManager } from './session-manager';
import { TelegramChat, TelegramMessage } from './models';

export class TelegramGatewayAdapter implements MessagingAdapter {
  name = 'telegram-gateway';

  async initialize() {
    await sessionManager.initialize();
  }

  async shutdown() {
    await sessionManager.shutdown();
  }

  getRouter(): Router {
    const router = Router();

    // POST /sessions/connect — create new session, return QR
    router.post('/sessions/connect', async (req: Request, res: Response) => {
      const { oxyUserId } = req.body;
      if (!oxyUserId) {
        return res.status(400).json({ error: 'oxyUserId is required' });
      }
      try {
        const { sessionId, qrPromise } = await sessionManager.createSession(oxyUserId);
        const qr = await qrPromise;
        return res.json({
          sessionId,
          status: 'qr-pending',
          qr,
          message: 'Scan the QR code with Telegram to connect',
        });
      } catch (error: any) {
        console.error('[Telegram] Connect error:', error);
        return res.status(500).json({ error: error.message || 'Failed to create session' });
      }
    });

    // GET /sessions/:sessionId/qr
    router.get('/sessions/:sessionId/qr', async (req: Request, res: Response) => {
      try {
        const session = await sessionManager.getStatus(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        if (session.status === 'connected') {
          return res.json({ status: 'connected', message: 'Already connected' });
        }
        return res.json({ status: session.status, qr: session.lastQR || null });
      } catch (error: any) {
        return res.status(500).json({ error: error.message });
      }
    });

    // GET /sessions/:sessionId/status
    router.get('/sessions/:sessionId/status', async (req: Request, res: Response) => {
      try {
        const session = await sessionManager.getStatus(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        return res.json(session);
      } catch (error: any) {
        return res.status(500).json({ error: error.message });
      }
    });

    // POST /sessions/:sessionId/disconnect
    router.post('/sessions/:sessionId/disconnect', async (req: Request, res: Response) => {
      try {
        await sessionManager.disconnectSession(req.params.sessionId);
        return res.json({ status: 'logged-out', message: 'Session disconnected' });
      } catch (error: any) {
        return res.status(500).json({ error: error.message });
      }
    });

    // GET /sessions/user/:userId
    router.get('/sessions/user/:userId', async (req: Request, res: Response) => {
      try {
        const sessions = await sessionManager.getUserSessions(req.params.userId);
        return res.json({ sessions });
      } catch (error: any) {
        return res.status(500).json({ error: error.message });
      }
    });

    // GET /sessions — list all
    router.get('/sessions', async (_req: Request, res: Response) => {
      try {
        const sessions = await sessionManager.listSessions();
        return res.json({ sessions });
      } catch (error: any) {
        return res.status(500).json({ error: error.message });
      }
    });

    // GET /sessions/:sessionId/chats
    router.get('/sessions/:sessionId/chats', async (req: Request, res: Response) => {
      try {
        const dbChats = await TelegramChat.find({ sessionId: req.params.sessionId })
          .sort({ lastMessageTimestamp: -1 })
          .limit(50)
          .lean();

        const chats = await Promise.all(
          dbChats.map(async (c: any) => {
            const lastMsg = await TelegramMessage.findOne({
              sessionId: req.params.sessionId,
              chatId: c.chatId,
            })
              .sort({ timestamp: -1 })
              .lean();

            return {
              chatId: c.chatId,
              name: c.name || String(c.chatId),
              unreadCount: c.unreadCount || 0,
              lastMessageTimestamp: c.lastMessageTimestamp || null,
              lastMessagePreview: (lastMsg as any)?.text?.slice(0, 100) || '',
            };
          }),
        );

        return res.json({ chats });
      } catch (error: any) {
        return res.status(500).json({ error: error.message });
      }
    });

    // GET /sessions/:sessionId/chats/:chatId/messages
    router.get('/sessions/:sessionId/chats/:chatId/messages', async (req: Request, res: Response) => {
      const { sessionId, chatId } = req.params;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

      try {
        const messages = await TelegramMessage.find({ sessionId, chatId })
          .sort({ timestamp: -1 })
          .limit(limit)
          .lean();

        return res.json({
          messages: messages.map((m: any) => ({
            id: String(m.messageId || m._id),
            fromMe: m.fromMe,
            timestamp: m.timestamp,
            text: m.text,
            senderName: m.senderName || null,
          })),
        });
      } catch (error: any) {
        return res.status(500).json({ error: error.message });
      }
    });

    // POST /sessions/:sessionId/send
    router.post('/sessions/:sessionId/send', async (req: Request, res: Response) => {
      const { chatId, text } = req.body;
      if (!chatId || !text) {
        return res.status(400).json({ error: 'chatId and text are required' });
      }
      try {
        const client = sessionManager.getSocket(req.params.sessionId);
        if (!client) {
          return res.status(404).json({ error: 'No active session' });
        }
        const result = await client.sendMessage(chatId, { message: text });
        return res.json({ success: true, messageId: String(result?.id) });
      } catch (error: any) {
        return res.status(500).json({ error: error.message });
      }
    });

    return router;
  }
}
