import { Request, Response, NextFunction } from 'express';
import { verifyToken, JWTPayload } from '../lib/jwt.js';
import { User } from '../models/user.js';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
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

    console.log('[optionalAuth] Token check:', {
      hasAuthHeader: !!authHeader,
      hasToken: !!token,
      tokenPreview: token ? token.substring(0, 20) + '...' : null
    });

    if (token) {
      const payload: JWTPayload = verifyToken(token);
      console.log('[optionalAuth] Token verified:', payload);

      const user = await User.findById(payload.userId);
      console.log('[optionalAuth] User found:', !!user, user?._id);

      if (user) {
        req.user = {
          id: payload.userId,
          email: payload.email,
        };
      }
    }

    next();
  } catch (error) {
    // Log errors in optional auth for debugging
    console.error('[optionalAuth] Error:', error instanceof Error ? error.message : error);
    next();
  }
}
