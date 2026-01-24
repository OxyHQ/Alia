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

/**
 * Oxy session authentication middleware
 * Uses validateSession() for session-based auth (not JWT)
 */
export async function authenticateToken(req: Request, res: Response, next: NextFunction): Promise<void> {
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

    const rawUser = user as any;
    const id = rawUser._id || rawUser.id;

    if (!id) {
      res.status(401).json({ error: 'Invalid user data' });
      return;
    }

    req.userId = id;
    req.user = { id };
    next();
  } catch (error) {
    console.error('[Auth] Session validation error:', error instanceof Error ? error.message : error);
    res.status(401).json({ error: 'Session validation failed' });
  }
}

/**
 * Optional auth - doesn't fail if no session
 * Tries Telegram bot auth first, then session auth
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Check if this is a Telegram bot request
  const botSecret = req.headers['x-telegram-bot-secret'] as string;
  if (botSecret) {
    // Delegate to bot auth middleware
    return authenticateTelegramBot(req, res, next);
  }

  // Otherwise try regular session auth
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

/**
 * Authenticate internal Telegram bot requests
 * The bot is a trusted server component that can act on behalf of linked users
 *
 * Security layers:
 * 1. Verifies bot secret matches server-side secret
 * 2. Validates user ID is provided
 * 3. Uses constant-time comparison to prevent timing attacks
 * 4. Logs authentication attempts for audit trail
 */
export async function authenticateTelegramBot(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const startTime = Date.now();

  try {
    const botSecret = req.headers['x-telegram-bot-secret'] as string;
    const oxyUserId = req.headers['x-oxy-user-id'] as string;
    const telegramId = req.headers['x-telegram-id'] as string;

    // Verify bot secret is configured
    const expectedSecret = process.env.TELEGRAM_BOT_SECRET;
    if (!expectedSecret) {
      console.error('[TelegramAuth] TELEGRAM_BOT_SECRET not configured');
      res.status(500).json({ error: 'Bot authentication not configured' });
      return;
    }

    // Verify secret provided
    if (!botSecret) {
      console.warn('[TelegramAuth] Missing bot secret from:', req.ip);
      res.status(401).json({ error: 'Bot authentication required' });
      return;
    }

    // Use crypto.timingSafeEqual to prevent timing attacks
    const expectedBuffer = Buffer.from(expectedSecret);
    const providedBuffer = Buffer.from(botSecret);

    if (expectedBuffer.length !== providedBuffer.length) {
      console.warn('[TelegramAuth] Invalid bot secret length from:', req.ip);
      res.status(401).json({ error: 'Invalid bot authentication' });
      return;
    }

    const crypto = await import('crypto');
    if (!crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
      console.warn('[TelegramAuth] Invalid bot secret from:', req.ip);
      res.status(401).json({ error: 'Invalid bot authentication' });
      return;
    }

    // Verify user ID is provided
    if (!oxyUserId) {
      console.warn('[TelegramAuth] Missing user ID in bot request');
      res.status(400).json({ error: 'User ID required for bot requests' });
      return;
    }

    // Verify telegram ID is provided
    if (!telegramId) {
      console.warn('[TelegramAuth] Missing telegram ID in bot request');
      res.status(400).json({ error: 'Telegram ID required for bot requests' });
      return;
    }

    // Log successful auth for audit trail
    const duration = Date.now() - startTime;
    console.log('[TelegramAuth] Authenticated bot request:', {
      telegramId,
      oxyUserId,
      ip: req.ip,
      endpoint: req.path,
      duration: `${duration}ms`
    });

    // Set user context - the bot is acting on behalf of this user
    req.userId = oxyUserId;
    req.user = { id: oxyUserId };
    next();
  } catch (error) {
    console.error('[TelegramAuth] Bot authentication error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}
