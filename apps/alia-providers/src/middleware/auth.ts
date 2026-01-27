import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

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

export function authenticateService(req: Request, res: Response, next: NextFunction) {
  const serviceName = req.headers['x-service-name'] as string;
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

  if (signature !== expectedSignature) {
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
