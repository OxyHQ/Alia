import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { oxyClient } from '../../../middleware/auth.js';

const SERVICE_SECRET = process.env.SERVICE_SECRET || '';
const ALLOWED_SERVICES = (process.env.ALLOWED_SERVICES || 'alia-api').split(',').map((s) => s.trim());

// Add service name to request
declare global {
  namespace Express {
    interface Request {
      service?: string;
    }
  }
}

/**
 * Authenticate requests to the providers module.
 * Supports two methods:
 * 1. Bearer token (admin UI) — delegates to the shared OxyHQ authenticateToken middleware
 * 2. HMAC service auth (service-to-service) — validates X-Service-Name/X-Timestamp/X-Signature headers
 */
export async function authenticateService(req: Request, res: Response, next: NextFunction) {
  const serviceName = req.headers['x-service-name'] as string;
  const authHeader = req.headers.authorization;

  // Bearer token auth (admin UI) — delegate to official oxyClient.auth() middleware
  if (authHeader?.startsWith('Bearer ') && !serviceName) {
    return oxyClient.auth({ loadUser: true })(req, res, (err?: any) => {
      if (err) return next(err);
      if (!req.userId) return next();

      // Admin gate: only allowed usernames can access providers admin
      const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || 'nate').split(',').map((s) => s.trim().toLowerCase());
      if (!req.user?.username || !ADMIN_USERNAMES.includes(req.user.username.toLowerCase())) {
        return res.status(403).json({ success: false, error: 'Admin access required', code: 'ADMIN_REQUIRED' });
      }

      req.service = 'admin-ui';
      next();
    });
  }

  // HMAC service-to-service auth
  const timestamp = req.headers['x-timestamp'] as string;
  const signature = req.headers['x-signature'] as string;

  if (!serviceName || !timestamp || !signature) {
    return res.status(401).json({
      success: false,
      error: 'Missing authentication headers',
      code: 'AUTHENTICATION_REQUIRED',
    });
  }

  if (!ALLOWED_SERVICES.includes(serviceName)) {
    return res.status(403).json({
      success: false,
      error: 'Service not allowed',
      code: 'SERVICE_NOT_ALLOWED',
    });
  }

  // Check timestamp (60 second window to prevent replay attacks)
  const now = Date.now();
  const requestTime = parseInt(timestamp, 10);
  if (isNaN(requestTime) || Math.abs(now - requestTime) > 60000) {
    return res.status(401).json({
      success: false,
      error: 'Request expired or invalid timestamp',
      code: 'REQUEST_EXPIRED',
    });
  }

  // Verify HMAC signature
  const payload = JSON.stringify({ timestamp, service: serviceName });
  const expectedSignature = crypto.createHmac('sha256', SERVICE_SECRET).update(payload).digest('hex');

  const sigBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return res.status(401).json({
      success: false,
      error: 'Invalid signature',
      code: 'INVALID_SIGNATURE',
    });
  }

  req.service = serviceName;
  next();
}

// Generate auth headers for outgoing service-to-service requests
export function generateAuthHeaders(serviceName: string): Record<string, string> {
  const timestamp = Date.now().toString();
  const payload = JSON.stringify({ timestamp, service: serviceName });
  const signature = crypto.createHmac('sha256', SERVICE_SECRET).update(payload).digest('hex');

  return {
    'X-Service-Name': serviceName,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
  };
}
