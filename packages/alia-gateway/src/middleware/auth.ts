import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { OxyServices } from '@oxyhq/core';

const oxyClient = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });

const SERVICE_SECRET = process.env.SERVICE_SECRET;
const ALLOWED_SERVICES = (process.env.ALLOWED_SERVICES || 'alia-api').split(',').map((s) => s.trim());

// Extend Express Request with service auth + OxyHQ user fields
declare global {
  namespace Express {
    interface Request {
      service?: string;
      userId?: string;
      user?: { username?: string; _id?: string; email?: string };
      rawBody?: Buffer;
    }
  }
}

/**
 * Canonical signing string for service-to-service HMAC.
 *
 * Binds the signature to the HTTP method, full request path (with query), and a
 * hash of the request body — not just `{ timestamp, service }`. Without the
 * method/path/body in the signed material, a captured signature could be
 * replayed against any other endpoint within the timestamp window. Signer and
 * verifier MUST build this string identically.
 */
export function buildServiceSigningString(parts: {
  timestamp: string;
  service: string;
  method: string;
  path: string;
  body: string | Buffer;
}): string {
  const bodyHash = crypto.createHash('sha256').update(parts.body || '').digest('hex');
  return [parts.timestamp, parts.service, parts.method.toUpperCase(), parts.path, bodyHash].join('\n');
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
    return oxyClient.auth({ loadUser: true })(req, res, (err?: unknown) => {
      if (err) {
        return next(err);
      }
      if (!req.userId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
          code: 'AUTHENTICATION_REQUIRED',
        });
      }

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

  if (!SERVICE_SECRET) {
    return res.status(500).json({
      success: false,
      error: 'Service authentication not configured',
      code: 'SERVICE_AUTH_NOT_CONFIGURED',
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

  // Verify HMAC signature over method + path + body, not just timestamp/service.
  const payload = buildServiceSigningString({
    timestamp,
    service: serviceName,
    method: req.method,
    path: req.originalUrl,
    body: req.rawBody ?? '',
  });
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
export function generateAuthHeaders(serviceName: string, method: string, path: string, body: string | Buffer = ''): Record<string, string> {
  if (!SERVICE_SECRET) {
    throw new Error('SERVICE_SECRET is not configured');
  }
  const timestamp = Date.now().toString();
  const payload = buildServiceSigningString({ timestamp, service: serviceName, method, path, body });
  const signature = crypto.createHmac('sha256', SERVICE_SECRET).update(payload).digest('hex');

  return {
    'X-Service-Name': serviceName,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
  };
}
