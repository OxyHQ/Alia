import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { OxyServices } from '@oxyhq/core';
import {
  createOptionalOxyAuth,
  createOxyAuthMiddleware,
  type OxyRequestUser,
  type OxyServiceAppContext,
} from '@oxyhq/core/server';
import { recordApiKeyUsage } from '../db/telemetry/apiKeyUsageRepository.js';
import { API_KEY_USAGE_METHODS } from '../domain/api-key-usage.js';
import { log } from '../lib/logger.js';
import { getDb } from '../db/index.js';
import { findAppById, findKeyByHash, touchKeyLastUsed } from '../db/developers/developerRepository.js';
import { hashDeveloperApiKey } from '../lib/api-key-crypto.js';
import { getConfiguredChannels } from '../lib/channels/registry.js';

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
      user?: OxyRequestUser | null;
      apiKey?: {
        id: string;
        appId: string;
        userId: string;
        scopes: string[];
      };
      serviceApp?: OxyServiceAppContext;
      _usageRecorded?: boolean;
      workspace?: {
        id: string | null;
        role?: 'owner' | 'admin' | 'member';
      };
    }
  }
}

/**
 * Oxy authentication middleware (official @oxyhq/core/server)
 * Validates JWT tokens (including service tokens) and sets req.userId, req.user, req.accessToken
 */
export const authenticateToken = createOxyAuthMiddleware(oxyClient, { auth: { debug: true } });

/**
 * Service-only auth — rejects anything that isn't a service token.
 * Use for internal-only endpoints (e.g., /internal/trigger).
 *
 * No `jwtSecret`, and Alia has none to give: `SERVICE_TOKEN_SECRET` exists in
 * neither this repository nor `deploy-aws.yml`. `@oxyhq/core` treats that as a
 * refusal rather than a licence — every service token gets 403
 * `SERVICE_TOKEN_NOT_CONFIGURED` — so this is fail-CLOSED and `/internal/trigger`
 * currently accepts nothing. Provisioning the secret in `oxy-infra` is what
 * turns it on, and `routes/__tests__/inference-boundary.test.ts` is the test
 * that has to be rewritten at that moment (epic #139 workstream 15).
 */
export const oxyServiceAuth = oxyClient.serviceAuth({ debug: true });

/**
 * Which Oxy environment this process IS.
 *
 * Used for the synthetic `serviceApp` below, which claimed `'production'`
 * unconditionally — a statement that was false on every staging task and every
 * developer machine. Nothing in Alia reads the field today, which is exactly why
 * a wrong value could sit there: the first reader would inherit the lie.
 *
 * The same three-way mapping as `lib/inference/kaana-client.ts`'s
 * `resolveDeploymentEnvironment`, and deliberately NOT imported from it — that
 * module is the unwired Relay client, and a middleware that imported it would
 * make the client reachable from the request path, which
 * `lib/inference/__tests__/kaana-boundary.test.ts` freezes against.
 */
function deploymentEnvironment(): OxyServiceAppContext['environment'] {
  if (process.env.NODE_ENV === 'production') return 'production';
  if (process.env.NODE_ENV === 'staging') return 'staging';
  return 'development';
}

/**
 * Optional auth - attaches user if token present, doesn't block if absent
 * Tries bot auth first (Telegram), then Oxy JWT auth
 */
const oxyOptionalAuth = createOptionalOxyAuth(oxyClient, { auth: { debug: true } });

export function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Check if this is a Telegram bot request
  const telegramBotSecret = req.headers['x-telegram-bot-secret'] as string;
  if (telegramBotSecret) {
    void authenticateTelegramBot(req, res, next);
    return;
  }

  // API keys should not go through JWT auth
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  if (token?.startsWith('alia_sk_')) {
    return next();
  }

  // Uses @oxyhq/core/server optional auth — attaches user if valid, continues if not.
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

    const keyHash = hashDeveloperApiKey(apiKey);
    const developerApiKey = await findKeyByHash(getDb(), keyHash);

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

    const app = await findAppById(getDb(), developerApiKey.appId);
    if (!app || !app.isActive) {
      res.status(401).json({ error: 'Associated app is inactive' });
      return;
    }

    // Every one of these was `.toString()` on an ObjectId; the columns are
    // `text`, so the conversion is gone rather than ported.
    req.apiKey = {
      id: developerApiKey.id,
      appId: developerApiKey.appId,
      userId: developerApiKey.oxyUserId,
      scopes: developerApiKey.scopes,
    };

    req.userId = developerApiKey.oxyUserId;
    req.user = { id: developerApiKey.oxyUserId };

    // Update last used (async) — a failure to stamp it must not fail the
    // request it describes.
    touchKeyLastUsed(getDb(), developerApiKey.id).catch((err: unknown) =>
      log.auth.error({ err }, 'Failed to update lastUsedAt'),
    );

    // Log usage after response (skip if the route already recorded usage via recordUsage())
    res.on('finish', async () => {
      if (req._usageRecorded) return;
      const responseTime = Date.now() - startTime;
      // The column accepts the five verbs this API exposes and a CHECK enforces
      // it, so anything else is recognised here rather than failing in the
      // driver. The Mongoose enum rejected the same set.
      const method = API_KEY_USAGE_METHODS.find((known) => known === req.method);
      if (!method) return;
      try {
        // `developerApiKey` is a Postgres row now, so the `String(...)` and
        // `.toString()` the ObjectId columns needed are gone rather than ported.
        await recordApiKeyUsage(getDb(), {
          apiKeyId: developerApiKey.id,
          oxyUserId: developerApiKey.oxyUserId,
          appId: developerApiKey.appId,
          endpoint: req.path,
          method,
          statusCode: res.statusCode,
          responseTimeMs: responseTime,
          userAgent: req.headers['user-agent'],
          authType: 'api_key',
        });
      } catch (err) {
        log.auth.error({ err }, 'Failed to log API key usage');
      }
    });

    next();
  } catch (error) {
    log.auth.error({ err: error }, 'API key authentication error');
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
    void authenticateTelegramBot(req, res, next);
    return;
  }

  // Channel bot secret (used by integrations service)
  const channelBotSecret = req.headers['x-channel-bot-secret'] as string;
  if (channelBotSecret) {
    void authenticateChannelBotSecret(req, res, next);
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

  // Internal service auth (e.g., browse tool calling Alia API as LLM)
  const serviceSecret = process.env.SERVICE_SECRET;
  if (serviceSecret && token.length === serviceSecret.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(serviceSecret))) {
    req.userId = 'system';
    req.user = { id: 'system' };
    req.serviceApp = {
      appId: 'internal',
      appName: 'internal',
      credentialId: 'service-secret',
      ownerAccountId: 'internal',
      scopes: ['internal'],
      environment: deploymentEnvironment(),
    };
    return next();
  }

  // API key auth
  if (token.startsWith('alia_sk_')) {
    void authenticateApiKey(req, res, next);
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
      log.auth.warn('Missing bot secret');
      res.status(401).json({ error: 'Bot authentication required' });
      return;
    }

    // Use crypto.timingSafeEqual to prevent timing attacks
    const expectedBuffer = Buffer.from(expectedSecret);
    const providedBuffer = Buffer.from(botSecret);

    if (expectedBuffer.length !== providedBuffer.length) {
      log.auth.warn('Invalid bot secret length');
      res.status(401).json({ error: 'Invalid bot authentication' });
      return;
    }

    const crypto = await import('crypto');
    if (!crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
      log.auth.warn('Invalid bot secret');
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
    log.auth.info({ telegramId, oxyUserId: oxyUserId || 'unknown', endpoint: req.path, durationMs: duration }, 'Telegram bot authenticated');

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

/**
 * Authenticate requests from the integrations service using a generic channel bot secret.
 *
 * Security layers:
 * 1. Reads `X-Channel-Bot-Secret` header and matches it against every
 *    configured channel's `config.getBotSecret()` using constant-time comparison
 * 2. Requires `X-Oxy-User-Id` header so the request carries user context
 * 3. Logs authentication attempts for audit trail
 */
export async function authenticateChannelBotSecret(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const channelBotSecret = req.headers['x-channel-bot-secret'] as string;
    const oxyUserId = req.headers['x-oxy-user-id'] as string;

    if (!channelBotSecret) {
      res.status(401).json({ error: 'Channel bot authentication required' });
      return;
    }

    if (!oxyUserId) {
      log.auth.warn('Missing X-Oxy-User-Id in channel bot request');
      res.status(401).json({ error: 'User context required for channel bot requests' });
      return;
    }

    // Validate oxyUserId is a valid 24-char hex ObjectId to prevent injection
    if (!/^[a-f0-9]{24}$/.test(oxyUserId)) {
      log.auth.warn({ oxyUserId }, 'Invalid oxyUserId format in channel bot request');
      res.status(400).json({ error: 'Invalid user ID format' });
      return;
    }

    const crypto = await import('crypto');
    const configuredChannels = getConfiguredChannels();
    const providedBuffer = Buffer.from(channelBotSecret);
    let matched = false;

    for (const channel of configuredChannels) {
      const expectedSecret = channel.config.getBotSecret();
      if (!expectedSecret) continue;

      const expectedBuffer = Buffer.from(expectedSecret);
      if (expectedBuffer.length !== providedBuffer.length) continue;

      if (crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
        matched = true;
        break;
      }
    }

    if (!matched) {
      log.auth.warn('Invalid channel bot secret');
      res.status(401).json({ error: 'Invalid channel bot authentication' });
      return;
    }

    log.auth.info(
      { oxyUserId, endpoint: req.path },
      'Channel bot authenticated'
    );

    req.userId = oxyUserId;
    req.user = { id: oxyUserId };
    next();
  } catch (error) {
    log.auth.error({ err: error }, 'Channel bot authentication error');
    res.status(500).json({ error: 'Authentication failed' });
  }
}
