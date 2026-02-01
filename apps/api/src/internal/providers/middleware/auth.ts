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

export async function authenticateService(req: Request, res: Response, next: NextFunction) {
  const serviceName = req.headers['x-service-name'] as string;
  const authHeader = req.headers.authorization;

  // Try Bearer token auth (for admin UI users)
  if (authHeader?.startsWith('Bearer ') && !serviceName) {
    const token = authHeader.substring(7);
    try {
      const { valid, user } = await oxyClient.validateSession(token);
      if (!valid || !user) {
        return res.status(401).json({
          success: false,
          error: 'Invalid or expired session',
          code: 'INVALID_SESSION',
        });
      }
      const rawUser = user as any;
      const id = rawUser._id || rawUser.id;
      if (!id) {
        return res.status(401).json({
          success: false,
          error: 'Invalid user data',
          code: 'INVALID_USER',
        });
      }
      req.userId = id;
      req.user = { id };
      req.service = 'admin-ui';
      return next();
    } catch (error) {
      return res.status(401).json({
        success: false,
        error: 'Session validation failed',
        code: 'SESSION_VALIDATION_FAILED',
      });
    }
  }

  // Fall back to HMAC service auth
  const timestamp = req.headers['x-timestamp'] as string;
  const signature = req.headers['x-signature'] as string;

  // Validate required headers
  if (!serviceName || !timestamp || !signature) {
    return res.status(401).json({
      success: false,
      error: 'Missing authentication headers',
      code: 'AUTHENTICATION_REQUIRED',
    });
  }

  // Check if service is allowed
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

  // Verify signature
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

  // Authentication successful
  req.service = serviceName;
  next();
}

// Generate auth headers for outgoing requests (if this service needs to call others)
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
