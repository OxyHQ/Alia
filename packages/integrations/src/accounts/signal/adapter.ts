import { Router, Request, Response } from 'express';
import { errorMessage } from '../../shared/utils';
import type { AccountAdapter } from '../types';
import { sessionManager } from './session-manager';
import { SignalChat, SignalMessage } from './models';

export class SignalAdapter implements AccountAdapter {
  name = 'signal-gateway';

  async initialize() {
    await sessionManager.initialize();
  }

  async shutdown() {
    await sessionManager.shutdown();
  }

  getRouter(): Router {
    const router = Router();

    // POST /sessions/link — link a new Signal device for user
    router.post('/sessions/link', async (req: Request, res: Response) => {
      const { oxyUserId } = req.body;
      if (!oxyUserId) {
        return res.status(400).json({ error: 'oxyUserId is required' });
      }
      try {
        const { sessionId, qrPromise } = await sessionManager.linkDevice(oxyUserId);
        const qr = await qrPromise;
        return res.json({
          sessionId,
          status: 'qr-pending',
          qr,
          message: 'Scan the QR code with Signal to link this device',
        });
      } catch (error: unknown) {
        console.error('[Signal] Link error:', error);
        return res.status(500).json({ error: errorMessage(error) || 'Failed to link device' });
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
      } catch (error: unknown) {
        return res.status(500).json({ error: errorMessage(error) });
      }
    });

    // GET /sessions/:sessionId/status
    router.get('/sessions/:sessionId/status', async (req: Request, res: Response) => {
      try {
        const session = await sessionManager.getStatus(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        return res.json(session);
      } catch (error: unknown) {
        return res.status(500).json({ error: errorMessage(error) });
      }
    });

    // POST /sessions/:sessionId/unlink
    router.post('/sessions/:sessionId/unlink', async (req: Request, res: Response) => {
      try {
        await sessionManager.unlinkDevice(req.params.sessionId);
        return res.json({ status: 'unlinked', message: 'Device unlinked' });
      } catch (error: unknown) {
        return res.status(500).json({ error: errorMessage(error) });
      }
    });

    // GET /sessions/user/:userId
    router.get('/sessions/user/:userId', async (req: Request, res: Response) => {
      try {
        const sessions = await sessionManager.getUserSessions(req.params.userId);
        return res.json({ sessions });
      } catch (error: unknown) {
        return res.status(500).json({ error: errorMessage(error) });
      }
    });

    // GET /sessions — list all
    router.get('/sessions', async (_req: Request, res: Response) => {
      try {
        const sessions = await sessionManager.listSessions();
        return res.json({ sessions });
      } catch (error: unknown) {
        return res.status(500).json({ error: errorMessage(error) });
      }
    });

    // GET /sessions/:sessionId/chats
    router.get('/sessions/:sessionId/chats', async (req: Request, res: Response) => {
      try {
        const dbChats = await SignalChat.find({ sessionId: req.params.sessionId })
          .sort({ lastMessageTimestamp: -1 })
          .limit(50)
          .lean();

        const chats = await Promise.all(
          dbChats.map(async (c) => {
            const lastMsg = await SignalMessage.findOne({
              sessionId: req.params.sessionId,
              contactId: c.contactId,
            })
              .sort({ timestamp: -1 })
              .lean();

            return {
              contactId: c.contactId,
              name: c.name || c.contactId,
              unreadCount: c.unreadCount || 0,
              lastMessageTimestamp: c.lastMessageTimestamp || null,
              lastMessagePreview: lastMsg?.text?.slice(0, 100) || '',
            };
          }),
        );

        return res.json({ chats });
      } catch (error: unknown) {
        return res.status(500).json({ error: errorMessage(error) });
      }
    });

    // GET /sessions/:sessionId/chats/:contactId/messages
    router.get('/sessions/:sessionId/chats/:contactId/messages', async (req: Request, res: Response) => {
      const { sessionId, contactId } = req.params;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

      try {
        const messages = await SignalMessage.find({ sessionId, contactId })
          .sort({ timestamp: -1 })
          .limit(limit)
          .lean();

        return res.json({
          messages: messages.map((m) => ({
            id: String(m.messageTimestamp || m._id),
            fromMe: m.fromMe,
            timestamp: m.timestamp,
            text: m.text,
            senderName: m.senderName || null,
          })),
        });
      } catch (error: unknown) {
        return res.status(500).json({ error: errorMessage(error) });
      }
    });

    // POST /sessions/:sessionId/send
    router.post('/sessions/:sessionId/send', async (req: Request, res: Response) => {
      const { contactId, text } = req.body;
      if (!contactId || !text) {
        return res.status(400).json({ error: 'contactId and text are required' });
      }
      try {
        const session = await sessionManager.getStatus(req.params.sessionId);
        if (!session || session.status !== 'connected') {
          return res.status(404).json({ error: 'No active session' });
        }
        // Send via signal-cli daemon HTTP API
        const daemonPort = session.daemonPort;
        if (!daemonPort) {
          return res.status(500).json({ error: 'Daemon not running' });
        }
        const resp = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipients: [contactId], message: text }),
        });
        const data = await resp.json();
        return res.json({ success: true, result: data });
      } catch (error: unknown) {
        return res.status(500).json({ error: errorMessage(error) });
      }
    });

    return router;
  }
}
