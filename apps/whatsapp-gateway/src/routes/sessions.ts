import { Router, Request, Response } from 'express';
import { sessionManager } from '../session-manager';

const router = Router();

/**
 * Middleware: authenticate all session routes with WHATSAPP_GATEWAY_SECRET.
 */
router.use((req: Request, res: Response, next) => {
  const secret = req.headers['x-gateway-secret'] || req.headers['x-channel-bot-secret'];
  const expected = process.env.WHATSAPP_GATEWAY_SECRET;

  if (!expected) {
    return res.status(500).json({ error: 'WHATSAPP_GATEWAY_SECRET not configured on server' });
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
 * Response: { status, qr? } or streams QR code once available.
 */
router.post('/connect', async (req: Request, res: Response) => {
  const { oxyUserId } = req.body;

  if (!oxyUserId) {
    return res.status(400).json({ error: 'oxyUserId is required' });
  }

  try {
    // Check if there's already a connected session
    const existing = await sessionManager.getStatus(oxyUserId);
    if (existing?.status === 'connected') {
      return res.json({
        status: 'connected',
        phoneNumber: existing.phoneNumber,
        displayName: existing.displayName,
        message: 'Session is already connected',
      });
    }

    // Create a new session and wait for the first QR code
    const { qrPromise } = await sessionManager.createSession(oxyUserId);

    // Wait for the QR code to be generated (with timeout)
    const qr = await qrPromise;

    return res.json({
      status: 'qr-pending',
      qr,
      message: 'Scan the QR code with WhatsApp to connect',
    });
  } catch (error: any) {
    console.error('[Sessions] Connect error:', error);
    return res.status(500).json({ error: error.message || 'Failed to create session' });
  }
});

/**
 * GET /sessions/:userId/qr
 * Returns the current QR code for a session that is awaiting scanning.
 */
router.get('/:userId/qr', async (req: Request, res: Response) => {
  const { userId } = req.params;

  try {
    const session = await sessionManager.getStatus(userId);

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
 * GET /sessions/:userId/status
 * Returns the current connection status of a user's session.
 */
router.get('/:userId/status', async (req: Request, res: Response) => {
  const { userId } = req.params;

  try {
    const session = await sessionManager.getStatus(userId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    return res.json({
      oxyUserId: session.oxyUserId,
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
 * POST /sessions/:userId/disconnect
 * Disconnects a user's WhatsApp session and clears auth data.
 */
router.post('/:userId/disconnect', async (req: Request, res: Response) => {
  const { userId } = req.params;

  try {
    await sessionManager.disconnectSession(userId);
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

export default router;
