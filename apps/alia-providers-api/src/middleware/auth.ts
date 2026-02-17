import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { OxyServices } from '@oxyhq/core';
// Auth health recording -- simplified for standalone service
const recordAuthSuccess = async (_type: string) => {};
const recordAuthFailure = async (_type: string, _reason: string) => {};

const oxyClient = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });

const SERVICE_SECRET = process.env.SERVICE_SECRET;
const ALLOWED_SERVICES = (process.env.ALLOWED_SERVICES || 'alia-api').split(',').map((s) => s.trim());

// Extend Express Request with service auth + OxyHQ user fields
declare global {
  namespace Express {
    interface Request {
      service?: string;
      userId?: string;
      user?: { username?: string; [key: string]: any };
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
      if (err) {
        recordAuthFailure('jwt', 'auth_middleware_error').catch(() => {});
        return next(err);
      }
      if (!req.userId) {
        recordAuthFailure('jwt', 'no_user_id').catch(() => {});
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
          code: 'AUTHENTICATION_REQUIRED',
        });
      }

      // Admin gate: only allowed usernames can access providers admin
      const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || 'nate').split(',').map((s) => s.trim().toLowerCase());
      if (!req.user?.username || !ADMIN_USERNAMES.includes(req.user.username.toLowerCase())) {
        recordAuthFailure('jwt', 'admin_access_denied').catch(() => {});
        return res.status(403).json({ success: false, error: 'Admin access required', code: 'ADMIN_REQUIRED' });
      }

      recordAuthSuccess('jwt').catch(() => {});
      req.service = 'admin-ui';
      next();
    });
  }

  // HMAC service-to-service auth
  const timestamp = req.headers['x-timestamp'] as string;
  const signature = req.headers['x-signature'] as string;

  if (!serviceName || !timestamp || !signature) {
    recordAuthFailure('service', 'missing_auth_headers').catch(() => {});
    return res.status(401).json({
      success: false,
      error: 'Missing authentication headers',
      code: 'AUTHENTICATION_REQUIRED',
    });
  }

  if (!SERVICE_SECRET) {
    recordAuthFailure('service', 'service_secret_not_configured').catch(() => {});
    return res.status(500).json({
      success: false,
      error: 'Service authentication not configured',
      code: 'SERVICE_AUTH_NOT_CONFIGURED',
    });
  }

  if (!ALLOWED_SERVICES.includes(serviceName)) {
    recordAuthFailure('service', `service_not_allowed:${serviceName}`).catch(() => {});
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
    recordAuthFailure('service', 'request_expired').catch(() => {});
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
    recordAuthFailure('service', 'invalid_signature').catch(() => {});
    return res.status(401).json({
      success: false,
      error: 'Invalid signature',
      code: 'INVALID_SIGNATURE',
    });
  }

  recordAuthSuccess('service').catch(() => {});
  req.service = serviceName;
  next();
}

// Generate auth headers for outgoing service-to-service requests
export function generateAuthHeaders(serviceName: string): Record<string, string> {
  if (!SERVICE_SECRET) {
    throw new Error('SERVICE_SECRET is not configured');
  }
  const timestamp = Date.now().toString();
  const payload = JSON.stringify({ timestamp, service: serviceName });
  const signature = crypto.createHmac('sha256', SERVICE_SECRET).update(payload).digest('hex');

  return {
    'X-Service-Name': serviceName,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
  };
}
