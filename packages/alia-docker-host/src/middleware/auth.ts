import type { Request, Response, NextFunction } from 'express';

const DOCKER_HOST_SECRET = process.env.DOCKER_HOST_SECRET;

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!DOCKER_HOST_SECRET) {
    res.status(500).json({ error: 'DOCKER_HOST_SECRET not configured' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Bearer token' });
    return;
  }

  const token = authHeader.slice(7);
  if (token !== DOCKER_HOST_SECRET) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  next();
}
