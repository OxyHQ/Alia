import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock dependencies.
vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(() => ({})),
}));

vi.mock('../../lib/logger.js', () => ({
  log: {
    auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock('../../lib/channels/registry.js', () => ({
  getConfiguredChannels: vi.fn(() => []),
}));

vi.mock('@oxy.so/core', () => {
  const passThroughMiddleware = (_req: Request, _res: Response, next: NextFunction) => next();

  class MockOxyServices {
    auth() { return vi.fn(passThroughMiddleware); }
    serviceAuth() { return vi.fn(passThroughMiddleware); }
  }
  return { OxyServices: MockOxyServices };
});

import {
  authenticateTelegramBot,
  authenticateTokenOrApiKey,
  optionalAuth,
} from '../auth.js';

type MockFn = ReturnType<typeof vi.fn>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    path: '/test',
    method: 'GET',
    ...overrides,
  } as Request;
}

type MockResponse = Response & {
  status: MockFn;
  json: MockFn;
  on: MockFn;
  statusCode: number;
};

function mockRes(): MockResponse {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    statusCode: 200,
    on: vi.fn(),
  };
  return res as unknown as MockResponse;
}

describe('auth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TELEGRAM_BOT_SECRET;
  });

  describe('authenticateTelegramBot', () => {
    it('rejects when TELEGRAM_BOT_SECRET not configured', async () => {
      delete process.env.TELEGRAM_BOT_SECRET;

      const req = mockReq({ headers: { 'x-telegram-bot-secret': 'some-secret' } });
      const res = mockRes();
      const next = vi.fn();

      await authenticateTelegramBot(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects missing bot secret', async () => {
      process.env.TELEGRAM_BOT_SECRET = 'correct-secret';

      const req = mockReq({ headers: {} });
      const res = mockRes();
      const next = vi.fn();

      await authenticateTelegramBot(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects wrong-length secret (prevents timing attack)', async () => {
      process.env.TELEGRAM_BOT_SECRET = 'correct-secret';

      const req = mockReq({ headers: { 'x-telegram-bot-secret': 'short' } });
      const res = mockRes();
      const next = vi.fn();

      await authenticateTelegramBot(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects incorrect secret', async () => {
      process.env.TELEGRAM_BOT_SECRET = 'correct-secret';

      const req = mockReq({
        headers: {
          'x-telegram-bot-secret': 'wrong--secret', // same length as "correct-secret"
          'x-telegram-id': '12345',
        },
      });
      const res = mockRes();
      const next = vi.fn();

      await authenticateTelegramBot(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects missing telegram ID', async () => {
      process.env.TELEGRAM_BOT_SECRET = 'test-secret';

      const req = mockReq({
        headers: {
          'x-telegram-bot-secret': 'test-secret',
        },
      });
      const res = mockRes();
      const next = vi.fn();

      await authenticateTelegramBot(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('succeeds with valid credentials', async () => {
      process.env.TELEGRAM_BOT_SECRET = 'test-secret';

      const req = mockReq({
        headers: {
          'x-telegram-bot-secret': 'test-secret',
          'x-telegram-id': '12345',
          'x-oxy-user-id': 'user-1',
        },
      });
      const res = mockRes();
      const next = vi.fn();

      await authenticateTelegramBot(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.userId).toBe('user-1');
    });
  });

  describe('authenticateTokenOrApiKey', () => {
    it('skips auth if user already set', () => {
      const req = mockReq();
      req.user = { id: 'user-1' };
      const res = mockRes();
      const next = vi.fn();

      authenticateTokenOrApiKey(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('rejects when no auth provided', () => {
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      authenticateTokenOrApiKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
    });

    it('refuses a retired alia_sk_ key by name, without reaching the Oxy SDK', () => {
      const req = mockReq({ headers: { authorization: `Bearer alia_sk_${'A1b2C3d4'.repeat(5)}` } });
      const res = mockRes();
      const next = vi.fn();

      authenticateTokenOrApiKey(req, res, next);

      // The SDK mock passes everything through, so reaching it would call next.
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'credential_retired' }));
      expect(req.user).toBeUndefined();
    });

    it('delegates Oxy bearer verification to the SDK middleware', () => {
      const req = mockReq({ headers: { authorization: 'Bearer signed-oxy-token' } });
      const res = mockRes();
      const next = vi.fn();

      authenticateTokenOrApiKey(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('optionalAuth', () => {
    it('gives a retired alia_sk_ key no bypass: it is just an unverified bearer', () => {
      // It used to skip Oxy entirely for an `alia_sk_` token, so the key lane
      // could run after it. There is no key lane any more; the token reaches
      // the optional Oxy verifier like any other string (passed through here
      // by the SDK mock), which leaves the request unauthenticated in reality.
      const req = mockReq({ headers: { authorization: 'Bearer alia_sk_whatever' } });
      const res = mockRes();
      const next = vi.fn();

      optionalAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
