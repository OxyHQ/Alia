import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { OxyServices } from '@oxyhq/core';

const SERVICE_SECRET = process.env.SERVICE_SECRET || '';
const ALLOWED_SERVICES = (process.env.ALLOWED_SERVICES || 'alia-api').split(',').map((s) => s.trim());

const oxyServices = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });

declare global {
  namespace Express {
    interface Request {
      service?: string;
      user?: any;
    }
  }
}

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

export async function authenticateOxy(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.substring(7);
  if (!token) {
    return res.status(401).json({ success: false, error: 'Missing token', code: 'AUTHENTICATION_REQUIRED' });
  }

  try {
    oxyServices.setTokens(token);
    const user = await oxyServices.getCurrentUser();

    if (user.username.toLowerCase() !== 'nate') {
      return res.status(403).json({ success: false, error: 'Access denied', code: 'FORBIDDEN' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid token', code: 'INVALID_TOKEN' });
  }
}

export function authenticateFlexible(req: Request, res: Response, next: NextFunction) {
  if (req.headers.authorization?.startsWith('Bearer ')) {
    return authenticateOxy(req, res, next);
  } else if (req.headers['x-service-name']) {
    return authenticateService(req, res, next);
  } else {
    return res.status(401).json({ success: false, error: 'Missing authentication', code: 'AUTHENTICATION_REQUIRED' });
  }
}

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
