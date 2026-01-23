import { Request, Response, NextFunction } from 'express';
import { OxyServices, OXY_CLOUD_URL } from '@oxyhq/services/core';
import DeveloperApiKey from '../models/developer-api-key.js';
import DeveloperApp from '../models/developer-app.js';
import ApiKeyUsage from '../models/api-key-usage.js';
import { User, IUser } from '../models/user.js';

// Initialize Oxy client for session validation
const oxyClient = new OxyServices({
  baseURL: process.env.OXY_API_URL || OXY_CLOUD_URL,
});

// Define Oxy user type from session validation
interface OxyUser {
  _id: string;
  id?: string; // Some responses use 'id' instead of '_id'
  email?: string;
  username?: string;
  name?: {
    first?: string;
    last?: string;
    full?: string; // Oxy provides this as a virtual field
  };
  avatar?: string;
  bio?: string;
  location?: string;
}

/**
 * Parse name from Oxy user - handles various formats
 */
function parseOxyUserName(oxyUser: OxyUser): { first: string; last: string } {
  // If we have first name, use it
  if (oxyUser.name?.first) {
    return {
      first: oxyUser.name.first,
      last: oxyUser.name.last || '',
    };
  }

  // If we have full name, split it
  if (oxyUser.name?.full) {
    const parts = oxyUser.name.full.trim().split(/\s+/);
    return {
      first: parts[0] || oxyUser.username || 'User',
      last: parts.slice(1).join(' ') || '',
    };
  }

  // Fall back to username
  return {
    first: oxyUser.username || 'User',
    last: '',
  };
}

/**
 * Ensures a local user record exists for the Oxy user.
 * Creates one if it doesn't exist, and updates name/avatar if changed.
 */
async function ensureLocalUser(oxyUser: OxyUser): Promise<IUser> {
  const userId = oxyUser._id || oxyUser.id;
  if (!userId) {
    throw new Error('Oxy user has no ID');
  }

  // Try to find existing user by Oxy ID
  let user = await User.findById(userId);
  const parsedName = parseOxyUserName(oxyUser);

  if (!user) {
    // Create new local user record with Oxy ID
    user = await User.create({
      _id: userId,
      email: oxyUser.email || `${userId}@oxy.user`,
      name: parsedName,
      image: oxyUser.avatar,
      // Credits will use schema defaults
    });
    console.log(`[Auth] Created local user for Oxy user ${userId}: ${parsedName.first} ${parsedName.last}`);
  } else {
    // Update user info if it has changed from Oxy
    const updates: any = {};

    // Update name if Oxy has a name and local doesn't match
    if (parsedName.first && parsedName.first !== 'User') {
      if (user.name?.first !== parsedName.first || user.name?.last !== parsedName.last) {
        updates.name = parsedName;
      }
    }

    // Update avatar if changed
    if (oxyUser.avatar && user.image !== oxyUser.avatar) {
      updates.image = oxyUser.avatar;
    }

    // Update email if changed
    if (oxyUser.email && user.email !== oxyUser.email && !user.email?.endsWith('@oxy.user')) {
      updates.email = oxyUser.email;
    }

    // Apply updates if any
    if (Object.keys(updates).length > 0) {
      user = await User.findByIdAndUpdate(userId, updates, { new: true }) || user;
      console.log(`[Auth] Updated local user ${userId}:`, updates);
    }
  }

  return user;
}

// Extend Express Request to include user and API key info
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email?: string;
        username?: string;
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
 * Middleware to authenticate requests using Oxy session
 * Extracts session ID from x-session-id header or Authorization Bearer token
 */
export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Get session ID from header or Authorization bearer
    const sessionId = req.headers['x-session-id'] as string ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.substring(7)
        : null);

    if (!sessionId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Skip Oxy validation for API keys (handled by authenticateApiKey)
    if (sessionId.startsWith('alia_sk_')) {
      res.status(401).json({ error: 'Use API key authentication endpoint' });
      return;
    }

    // Validate session with Oxy
    const { valid, user } = await oxyClient.validateSession(sessionId);

    if (!valid || !user) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    // Cast Oxy user to expected type
    const oxyUser = user as unknown as OxyUser;

    // Ensure local user record exists (for credits, etc.)
    await ensureLocalUser(oxyUser);

    // Attach user info to request
    req.user = {
      id: oxyUser._id,
      email: oxyUser.email,
      username: oxyUser.username,
    };

    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(401).json({ error: 'Session validation failed' });
  }
}

/**
 * Optional middleware that doesn't fail if no session provided
 * Useful for endpoints that work both authenticated and unauthenticated
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
        const oxyUser = user as unknown as OxyUser;

        // Ensure local user record exists
        await ensureLocalUser(oxyUser);

        req.user = {
          id: oxyUser._id,
          email: oxyUser.email,
          username: oxyUser.username,
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
 * Middleware that accepts both Oxy sessions and API keys
 * Tries session first, falls back to API key
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
  const sessionId = req.headers['x-session-id'] as string;

  if (!token && !sessionId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // Check if it's an API key
  if (token?.startsWith('alia_sk_')) {
    return authenticateApiKey(req, res, next);
  }

  // Otherwise, treat it as an Oxy session
  return authenticateToken(req, res, next);
}

/**
 * Middleware to check if the API key has a specific scope
 */
export function requireScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // If authenticated with session, allow all scopes
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
