import { Request, Response, NextFunction } from 'express';
import { OxyServices } from '@oxyhq/core';
import DeveloperApiKey from '../models/developer-api-key.js';
import DeveloperApp from '../models/developer-app.js';
import ApiKeyUsage from '../models/api-key-usage.js';
import { log } from '../lib/logger.js';
import { getClientIp } from '../lib/net-utils.js';

// Initialize Oxy client
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
export const oxyClient = new OxyServices({
  baseURL: OXY_API_URL,
});

// Extend Express Request for API keys and service tokens
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      accessToken?: string;
      user?: { id: string; username?: string; [key: string]: any };
      apiKey?: {
        id: string;
        appId: string;
        userId: string;
        scopes: string[];
      };
      serviceApp?: {
        appId: string;
        appName: string;
      };
      workspace?: {
        id: string | null;
        role?: 'owner' | 'admin' | 'member';
      };
    }
  }
}

/**
 * Oxy authentication middleware (official @oxyhq/core)
 * Validates JWT tokens (including service tokens) and sets req.userId, req.user, req.accessToken
 */
export const authenticateToken = oxyClient.auth({ debug: true });

/**
 * Service-only auth — rejects anything that isn't a service token.
 * Use for internal-only endpoints (e.g., /internal/trigger).
 */
export const oxyServiceAuth = oxyClient.serviceAuth({ debug: true });

/**
 * Optional auth - attaches user if token present, doesn't block if absent
 * Tries bot auth first (Telegram), then Oxy JWT auth
 */
const oxyOptionalAuth = oxyClient.auth({ optional: true, debug: true });

export function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Check if this is a Telegram bot request
  const telegramBotSecret = req.headers['x-telegram-bot-secret'] as string;
  if (telegramBotSecret) {
    authenticateTelegramBot(req, res, next);
    return;
  }

  // API keys should not go through JWT auth
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  if (token?.startsWith('alia_sk_')) {
    return next();
  }

  // Use oxyClient.auth({ optional: true }) — attaches user if valid, continues if not
  oxyOptionalAuth(req, res, next);
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
    }).catch((err) => log.auth.error({ err }, 'Failed to update lastUsedAt'));

    // Log usage after response (skip if the route already recorded usage via recordUsage())
    res.on('finish', async () => {
      if ((req as any)._usageRecorded) return;
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
          ipAddress: getClientIp(req),
          authType: 'api_key',
        });
      } catch (err) {
        log.auth.error({ err }, 'Failed to log API key usage');
      }
    });

    next();
  } catch (error) {
    log.auth.error({ err: error, ip: getClientIp(req) }, 'API key authentication error');
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Accepts both Oxy JWT tokens and API keys
 * Also supports Telegram bot authentication
 */
export function authenticateTokenOrApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Already authenticated (e.g., by channel bot pre-middleware)
  if (req.user) {
    return next();
  }

  // Check for Telegram bot authentication first
  const telegramBotSecret = req.headers['x-telegram-bot-secret'] as string;
  if (telegramBotSecret) {
    authenticateTelegramBot(req, res, next);
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.substring(7)
    : null;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // API key auth
  if (token.startsWith('alia_sk_')) {
    authenticateApiKey(req, res, next);
    return;
  }

  // Oxy JWT auth
  authenticateToken(req, res, next);
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
      log.auth.error('TELEGRAM_BOT_SECRET not configured');
      res.status(500).json({ error: 'Bot authentication not configured' });
      return;
    }

    // Verify secret provided
    if (!botSecret) {
      log.auth.warn({ ip: getClientIp(req) }, 'Missing bot secret');
      res.status(401).json({ error: 'Bot authentication required' });
      return;
    }

    // Use crypto.timingSafeEqual to prevent timing attacks
    const expectedBuffer = Buffer.from(expectedSecret);
    const providedBuffer = Buffer.from(botSecret);

    if (expectedBuffer.length !== providedBuffer.length) {
      log.auth.warn({ ip: getClientIp(req) }, 'Invalid bot secret length');
      res.status(401).json({ error: 'Invalid bot authentication' });
      return;
    }

    const crypto = await import('crypto');
    if (!crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
      log.auth.warn({ ip: getClientIp(req) }, 'Invalid bot secret');
      res.status(401).json({ error: 'Invalid bot authentication' });
      return;
    }

    // Verify telegram ID is provided
    if (!telegramId) {
      log.auth.warn('Missing telegram ID in bot request');
      res.status(400).json({ error: 'Telegram ID required for bot requests' });
      return;
    }

    // Log successful auth for audit trail
    const duration = Date.now() - startTime;
    log.auth.info({ telegramId, oxyUserId: oxyUserId || 'unknown', ip: getClientIp(req), endpoint: req.path, durationMs: duration }, 'Telegram bot authenticated');

    // Set user context if provided - the bot is acting on behalf of this user
    if (oxyUserId) {
      req.userId = oxyUserId;
      req.user = { id: oxyUserId };
    }
    next();
  } catch (error) {
    log.auth.error({ err: error }, 'Bot authentication error');
    res.status(500).json({ error: 'Authentication failed' });
  }
}

