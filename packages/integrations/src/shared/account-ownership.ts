import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { internalAccount, isWorkloadRequest } from './internal-auth';

export function accountOwnership(
  ownerOf: (sessionId: string) => Promise<string | null>,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!isWorkloadRequest(req)) {
      next();
      return;
    }
    const accountId = internalAccount(req);
    if (!accountId) {
      res.status(401).json({ error: 'Internal account context required' });
      return;
    }
    // The API has already resolved a session/task owner. A body cannot replace it.
    if (req.body && typeof req.body === 'object') req.body.oxyUserId = accountId;
    if (req.path === '/sessions' || req.path.startsWith('/sessions/user/')) {
      req.url = `/sessions/user/${encodeURIComponent(accountId)}`;
      next();
      return;
    }
    const match = /^\/sessions\/([^/]+)/.exec(req.path);
    if (match && !['connect', 'link'].includes(match[1])) {
      try {
        if ((await ownerOf(decodeURIComponent(match[1]))) !== accountId) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }
      } catch {
        res.status(503).json({ error: 'Session unavailable' });
        return;
      }
    }
    next();
  };
}
