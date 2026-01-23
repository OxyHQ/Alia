import { Request, Response, NextFunction } from 'express';
import { OxyServices } from '@oxyhq/services/core';
import DeveloperApiKey from '../models/developer-api-key.js';
import DeveloperApp from '../models/developer-app.js';
import ApiKeyUsage from '../models/api-key-usage.js';

// Initialize Oxy client
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
export const oxyClient = new OxyServices({
  baseURL: OXY_API_URL,
});

// Extend Express Request for API keys
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      accessToken?: string;
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

// Oxy's built-in auth middleware
const oxyAuth = oxyClient.auth({
  debug: process.env.NODE_ENV === 'development',
  loadUser: true,
});

/**
 * Oxy session authentication middleware
 * Wraps Oxy's auth() to also support x-session-id header
 */
export function authenticateToken(req: Request, res: Response, next: NextFunction) {
  // If x-session-id is provided but no Authorization, copy it
  const sessionId = req.headers['x-session-id'] as string;
  if (sessionId && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${sessionId}`;
  }

  // Use Oxy's middleware
  return oxyAuth(req, res, next);
}

/**
 * Optional auth - doesn't fail if no session
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers['authorization'];
  const sessionId = req.headers['x-session-id'] as string;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : sessionId;

  if (!token || token.startsWith('alia_sk_')) {
    return next();
  }

  // Try to authenticate but don't fail
  try {
    const { valid, user } = await oxyClient.validateSession(token);
    if (valid && user) {
      const rawUser = user as any;
      req.userId = rawUser._id || rawUser.id;
      req.user = { id: req.userId! };
    }
  } catch (error) {
    // Silently continue without auth
  }

  next();
}

/**
 * Developer API Key authentication
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
      userId: developerApiKey.oxyUserId.toString(),
      scopes: developerApiKey.scopes,
    };

    req.userId = developerApiKey.oxyUserId.toString();
    req.user = { id: developerApiKey.oxyUserId.toString() };

    // Update last used (async)
    DeveloperApiKey.findByIdAndUpdate(developerApiKey._id, {
      lastUsedAt: new Date(),
    }).catch((err) => console.error('Failed to update lastUsedAt:', err));

    // Log usage after response
    res.on('finish', async () => {
      const responseTime = Date.now() - startTime;
      try {
        await ApiKeyUsage.create({
          apiKeyId: developerApiKey._id,
          oxyUserId: developerApiKey.oxyUserId,
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

  // API key auth
  if (token?.startsWith('alia_sk_')) {
    return authenticateApiKey(req, res, next);
  }

  // Oxy session auth
  return authenticateToken(req, res, next);
}

/**
 * Check if API key has a specific scope
 */
export function requireScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Session users have all scopes
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
