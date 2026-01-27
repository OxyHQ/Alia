/**
 * Authentication Middleware
 * Supports both HMAC (service-to-service) and OxyHQ (admin panel)
 */

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { OxyServices } from '@oxyhq/services/core';

const SERVICE_SECRET = process.env.SERVICE_SECRET || '';
const ALLOWED_SERVICES = (process.env.ALLOWED_SERVICES || 'alia-api').split(',').map((s) => s.trim());

// Oxy client
const oxyServices = new OxyServices({
  baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
});

// Add service/user info to request
declare global {
  namespace Express {
    interface Request {
      service?: string;
      user?: any;
    }
  }
}

/**
 * HMAC Authentication (for service-to-service calls)
 */
export function authenticateService(req: Request, res: Response, next: NextFunction) {
  const serviceName = req.headers['x-service-name'] as string;
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

  const now = Date.now();
  const requestTime = parseInt(timestamp, 10);
  if (isNaN(requestTime) || Math.abs(now - requestTime) > 60000) {
    return res.status(401).json({
      success: false,
      error: 'Request expired or invalid timestamp',
      code: 'REQUEST_EXPIRED',
    });
  }

  const payload = JSON.stringify({ timestamp, service: serviceName });
  const expectedSignature = crypto.createHmac('sha256', SERVICE_SECRET).update(payload).digest('hex');

  if (signature !== expectedSignature) {
    return res.status(401).json({
      success: false,
      error: 'Invalid signature',
      code: 'INVALID_SIGNATURE',
    });
  }

  req.service = serviceName;
  next();
}

/**
 * OxyHQ Authentication (for admin panel)
 * Only allows username "nate"
 */
export async function authenticateOxy(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Missing authentication token',
      code: 'AUTHENTICATION_REQUIRED',
    });
  }

  const token = authHeader.substring(7);

  try {
    // Use Oxy services to validate token
    oxyServices.setTokens(token);
    const user = await oxyServices.getCurrentUser();

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid session',
        code: 'INVALID_TOKEN',
      });
    }

    // Only allow username "nate"
    if (user.username.toLowerCase() !== 'nate') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Only admin users allowed.',
        code: 'FORBIDDEN',
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('[Auth] Oxy authentication failed:', error);
    return res.status(401).json({
      success: false,
      error: 'Authentication failed',
      code: 'INVALID_TOKEN',
    });
  }
}

/**
 * Flexible auth: try Oxy first, then HMAC
 */
export function authenticateFlexible(req: Request, res: Response, next: NextFunction) {
  if (req.headers.authorization?.startsWith('Bearer ')) {
    return authenticateOxy(req, res, next);
  } else if (req.headers['x-service-name']) {
    return authenticateService(req, res, next);
  } else {
    return res.status(401).json({
      success: false,
      error: 'Missing authentication',
      code: 'AUTHENTICATION_REQUIRED',
    });
  }
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
