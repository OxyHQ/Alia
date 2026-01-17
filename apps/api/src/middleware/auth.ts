import { Request, Response, NextFunction } from 'express';
import { verifyToken, JWTPayload } from '../lib/jwt.js';
import { User } from '../models/user.js';
import DeveloperApiKey from '../models/developer-api-key.js';
import DeveloperApp from '../models/developer-app.js';
import ApiKeyUsage from '../models/api-key-usage.js';

// Extend Express Request to include user and API key info
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
      };
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
 * Middleware to authenticate requests using JWT
 * Extracts token from Authorization header and validates it
 */
export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : null;

    if (!token) {
      res.status(401).json({ error: 'Authentication token required' });
      return;
    }

    // Verify token
    const payload: JWTPayload = verifyToken(token);

    // Optional: Verify user still exists in database
    const user = await User.findById(payload.userId);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    // Attach user info to request
    req.user = {
      id: payload.userId,
      email: payload.email,
    };

    next();
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid or expired token') {
      res.status(401).json({ error: 'Invalid or expired token' });
    } else {
      res.status(500).json({ error: 'Authentication failed' });
    }
  }
}

/**
 * Optional middleware that doesn't fail if no token provided
 * Useful for endpoints that work both authenticated and unauthenticated
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : null;

    if (token) {
      const payload: JWTPayload = verifyToken(token);
      const user = await User.findById(payload.userId);

      if (user) {
        req.user = {
          id: payload.userId,
          email: payload.email,
        };
      }
    }

    next();
  } catch (error) {
    console.error('Optional auth error:', error instanceof Error ? error.message : error);
    next();
  }
}

/**
 * Middleware to authenticate requests using Developer API Keys
 * Validates API key, checks expiration, scopes, and logs usage
 */
export async function authenticateApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const startTime = Date.now();

  try {
    // Get API key from Authorization header
    const authHeader = req.headers.authorization;
    const apiKey = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : null;

    if (!apiKey) {
      res.status(401).json({ error: 'API key required' });
      return;
    }

    // Check if it's an API key (starts with alia_sk_)
    if (!apiKey.startsWith('alia_sk_')) {
      res.status(401).json({ error: 'Invalid API key format' });
      return;
    }

    // Hash the key to look it up in the database
    const keyHash = (DeveloperApiKey as any).hashKey(apiKey);

    // Find the API key in the database
    const developerApiKey = await DeveloperApiKey.findOne({ keyHash });

    if (!developerApiKey) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    // Check if the key is active
    if (!developerApiKey.isActive) {
      res.status(401).json({ error: 'API key is inactive' });
      return;
    }

    // Check if the key has expired
    if (developerApiKey.expiresAt && developerApiKey.expiresAt < new Date()) {
      res.status(401).json({ error: 'API key has expired' });
      return;
    }

    // Check if the app is active
    const app = await DeveloperApp.findById(developerApiKey.appId);
    if (!app || !app.isActive) {
      res.status(401).json({ error: 'Associated app is inactive' });
      return;
    }

    // Attach API key info to request
    req.apiKey = {
      id: developerApiKey._id.toString(),
      appId: developerApiKey.appId.toString(),
      userId: developerApiKey.userId.toString(),
      scopes: developerApiKey.scopes,
    };

    // Also attach user info for compatibility
    const user = await User.findById(developerApiKey.userId);
    if (user) {
      req.user = {
        id: user._id.toString(),
        email: user.email,
      };
    }

    // Update last used timestamp (async, don't wait)
    DeveloperApiKey.findByIdAndUpdate(developerApiKey._id, {
      lastUsedAt: new Date(),
    }).catch((err) => console.error('Failed to update lastUsedAt:', err));

    // Log usage after response is sent
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
 * Middleware that accepts both JWT tokens and API keys
 * Tries JWT first, falls back to API key
 */
export async function authenticateTokenOrApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.substring(7)
    : null;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // Check if it's an API key
  if (token.startsWith('alia_sk_')) {
    return authenticateApiKey(req, res, next);
  }

  // Otherwise, treat it as a JWT token
  return authenticateToken(req, res, next);
}

/**
 * Middleware to check if the API key has a specific scope
 */
export function requireScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // If authenticated with JWT, allow all scopes
    if (req.user && !req.apiKey) {
      return next();
    }

    // If authenticated with API key, check scopes
    if (req.apiKey && req.apiKey.scopes.includes(scope)) {
      return next();
    }

    res.status(403).json({
      error: 'Insufficient permissions',
      required_scope: scope
    });
  };
}
