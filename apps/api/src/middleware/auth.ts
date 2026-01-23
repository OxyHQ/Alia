import { Request, Response, NextFunction } from 'express';
import { OxyServices } from '@oxyhq/services/core';
import DeveloperApiKey from '../models/developer-api-key.js';
import DeveloperApp from '../models/developer-app.js';
import ApiKeyUsage from '../models/api-key-usage.js';

// Initialize Oxy client for session validation
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
export const oxyClient = new OxyServices({
  baseURL: OXY_API_URL,
});

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: { id: string };
      apiKey?: {
        id: string;
        appId: string;
        userId: string;
        scopes: string[];
      };
    }
  }
}

/**
 * Middleware to authenticate requests using Oxy session
 */
export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const sessionId = req.headers['x-session-id'] as string ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.substring(7)
        : null);

    if (!sessionId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (sessionId.startsWith('alia_sk_')) {
      res.status(401).json({ error: 'Use API key authentication endpoint' });
      return;
    }

    const { valid, user } = await oxyClient.validateSession(sessionId);

    if (!valid || !user) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    const oxyUser = user as { _id: string; id?: string };
    const userId = oxyUser._id || oxyUser.id;

    if (!userId) {
      res.status(401).json({ error: 'Invalid user data' });
      return;
    }

    req.user = { id: userId };
    next();
  } catch (error) {
    console.error('[Auth] Session validation error:', error instanceof Error ? error.message : error);
    res.status(401).json({ error: 'Session validation failed' });
  }
}

/**
 * Optional auth - doesn't fail if no session
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const sessionId = req.headers['x-session-id'] as string ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.substring(7)
        : null);

    if (sessionId && !sessionId.startsWith('alia_sk_')) {
      const { valid, user } = await oxyClient.validateSession(sessionId);

      if (valid && user) {
        const oxyUser = user as { _id: string; id?: string };
        const userId = oxyUser._id || oxyUser.id;
        if (userId) {
          req.user = { id: userId };
        }
      }
    }

    next();
  } catch (error) {
    console.error('Optional auth error:', error instanceof Error ? error.message : error);
    next();
  }
}

/**
 * Middleware to authenticate using Developer API Keys
 */
export async function authenticateApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const startTime = Date.now();

  try {
    const authHeader = req.headers.authorization;
    const apiKey = authHeader?.startsWith('Bearer ')
      ? authHeader.substring(7)
      : null;

    if (!apiKey) {
      res.status(401).json({ error: 'API key required' });
      return;
    }

    if (!apiKey.startsWith('alia_sk_')) {
      res.status(401).json({ error: 'Invalid API key format' });
      return;
    }

    const keyHash = (DeveloperApiKey as any).hashKey(apiKey);
    const developerApiKey = await DeveloperApiKey.findOne({ keyHash });

    if (!developerApiKey) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    if (!developerApiKey.isActive) {
      res.status(401).json({ error: 'API key is inactive' });
      return;
    }

    if (developerApiKey.expiresAt && developerApiKey.expiresAt < new Date()) {
      res.status(401).json({ error: 'API key has expired' });
      return;
    }

    const app = await DeveloperApp.findById(developerApiKey.appId);
    if (!app || !app.isActive) {
      res.status(401).json({ error: 'Associated app is inactive' });
      return;
    }

    req.apiKey = {
      id: developerApiKey._id.toString(),
      appId: developerApiKey.appId.toString(),
      userId: developerApiKey.userId.toString(),
      scopes: developerApiKey.scopes,
    };

    req.user = { id: developerApiKey.userId.toString() };

    DeveloperApiKey.findByIdAndUpdate(developerApiKey._id, {
      lastUsedAt: new Date(),
    }).catch((err) => console.error('Failed to update lastUsedAt:', err));

    res.on('finish', async () => {
      const responseTime = Date.now() - startTime;
      try {
        await ApiKeyUsage.create({
          apiKeyId: developerApiKey._id,
          userId: developerApiKey.userId,
          appId: developerApiKey.appId,
          endpoint: req.path,
          method: req.method,
          statusCode: res.statusCode,
          responseTime,
          userAgent: req.headers['user-agent'],
          ipAddress: req.ip || req.socket.remoteAddress,
        });
      } catch (err) {
        console.error('Failed to log API key usage:', err);
      }
    });

    next();
  } catch (error) {
    console.error('API key authentication error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Accepts both Oxy sessions and API keys
 */
export async function authenticateTokenOrApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.substring(7)
    : null;
  const sessionId = req.headers['x-session-id'] as string;

  if (!token && !sessionId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (token?.startsWith('alia_sk_')) {
    return authenticateApiKey(req, res, next);
  }

  return authenticateToken(req, res, next);
}

/**
 * Check if API key has a specific scope
 */
export function requireScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.user && !req.apiKey) {
      return next();
    }

    if (req.apiKey?.scopes.includes(scope)) {
      return next();
    }

    res.status(403).json({
      error: 'Insufficient permissions',
      required_scope: scope
    });
  };
}
