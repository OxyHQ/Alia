import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock dependencies
vi.mock('../../models/developer-api-key.js', () => {
  const hashKey = vi.fn((key: string) => `hashed_${key}`);
  return {
    default: {
      findOne: vi.fn(),
      findByIdAndUpdate: vi.fn().mockReturnValue({ catch: vi.fn() }),
      hashKey,
    },
  };
});

vi.mock('../../models/developer-app.js', () => ({
  default: {
    findById: vi.fn(),
  },
}));

vi.mock('../../models/api-key-usage.js', () => ({
  default: {
    create: vi.fn(),
  },
}));

vi.mock('../../lib/logger.js', () => ({
  log: {
    auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock('../../lib/net-utils.js', () => ({
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../lib/channels/registry.js', () => ({
  getConfiguredChannels: vi.fn(() => []),
}));

vi.mock('@oxyhq/core', () => {
  class MockOxyServices {
    auth() { return vi.fn((_req: any, _res: any, next: any) => next()); }
    serviceAuth() { return vi.fn((_req: any, _res: any, next: any) => next()); }
  }
  return { OxyServices: MockOxyServices };
});

import DeveloperApiKey from '../../models/developer-api-key.js';
import DeveloperApp from '../../models/developer-app.js';
import {
  authenticateApiKey,
  authenticateTelegramBot,
  authenticateTokenOrApiKey,
  requireScope,
} from '../auth.js';

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    path: '/test',
    method: 'GET',
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    statusCode: 200,
    on: vi.fn(),
  };
  return res as Response;
}

describe('auth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TELEGRAM_BOT_SECRET;
    delete process.env.SERVICE_SECRET;
  });

  describe('authenticateApiKey', () => {
    it('rejects missing authorization header', async () => {
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      await authenticateApiKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'API key required' });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects non-alia_sk_ prefix', async () => {
      const req = mockReq({ headers: { authorization: 'Bearer sk_invalid_key' } });
      const res = mockRes();
      const next = vi.fn();

      await authenticateApiKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key format' });
    });

    it('rejects unknown API key', async () => {
      (DeveloperApiKey as any).findOne.mockResolvedValue(null);

      const req = mockReq({ headers: { authorization: 'Bearer alia_sk_test123' } });
      const res = mockRes();
      const next = vi.fn();

      await authenticateApiKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' });
    });

    it('rejects inactive API key', async () => {
      (DeveloperApiKey as any).findOne.mockResolvedValue({
        _id: 'key-1',
        isActive: false,
        appId: 'app-1',
        oxyUserId: 'user-1',
        scopes: [],
      });

      const req = mockReq({ headers: { authorization: 'Bearer alia_sk_test123' } });
      const res = mockRes();
      const next = vi.fn();

      await authenticateApiKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'API key is inactive' });
    });

    it('rejects expired API key', async () => {
      (DeveloperApiKey as any).findOne.mockResolvedValue({
        _id: 'key-1',
        isActive: true,
        expiresAt: new Date('2020-01-01'),
        appId: 'app-1',
        oxyUserId: 'user-1',
        scopes: [],
      });

      const req = mockReq({ headers: { authorization: 'Bearer alia_sk_test123' } });
      const res = mockRes();
      const next = vi.fn();

      await authenticateApiKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'API key has expired' });
    });

    it('rejects when app is inactive', async () => {
      (DeveloperApiKey as any).findOne.mockResolvedValue({
        _id: 'key-1',
        isActive: true,
        appId: 'app-1',
        oxyUserId: 'user-1',
        scopes: ['chat'],
      });
      (DeveloperApp as any).findById.mockResolvedValue({ isActive: false });

      const req = mockReq({ headers: { authorization: 'Bearer alia_sk_test123' } });
      const res = mockRes();
      const next = vi.fn();

      await authenticateApiKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Associated app is inactive' });
    });

    it('succeeds with valid API key', async () => {
      (DeveloperApiKey as any).findOne.mockResolvedValue({
        _id: { toString: () => 'key-1' },
        isActive: true,
        appId: { toString: () => 'app-1' },
        oxyUserId: { toString: () => 'user-1' },
        scopes: ['chat', 'memory'],
      });
      (DeveloperApp as any).findById.mockResolvedValue({ isActive: true });

      const req = mockReq({ headers: { authorization: 'Bearer alia_sk_test123' } });
      const res = mockRes();
      const next = vi.fn();

      await authenticateApiKey(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.apiKey).toEqual({
        id: 'key-1',
        appId: 'app-1',
        userId: 'user-1',
        scopes: ['chat', 'memory'],
      });
      expect(req.userId).toBe('user-1');
    });
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
      (req as any).user = { id: 'user-1' };
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

    it('allows service secret auth', () => {
      process.env.SERVICE_SECRET = 'my-service-secret';

      const req = mockReq({ headers: { authorization: 'Bearer my-service-secret' } });
      const res = mockRes();
      const next = vi.fn();

      authenticateTokenOrApiKey(req, res, next);

      expect(next).toHaveBeenCalled();
      expect((req as any).user).toEqual({ id: 'system' });
    });
  });

  describe('requireScope', () => {
    it('passes session users without checking scope', () => {
      const req = mockReq();
      (req as any).user = { id: 'user-1' };
      const res = mockRes();
      const next = vi.fn();

      requireScope('chat')(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('passes API key users with matching scope', () => {
      const req = mockReq();
      (req as any).user = { id: 'user-1' };
      (req as any).apiKey = { id: 'key-1', appId: 'app-1', userId: 'user-1', scopes: ['chat', 'memory'] };
      const res = mockRes();
      const next = vi.fn();

      requireScope('chat')(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('rejects API key users without matching scope', () => {
      const req = mockReq();
      (req as any).user = { id: 'user-1' };
      (req as any).apiKey = { id: 'key-1', appId: 'app-1', userId: 'user-1', scopes: ['memory'] };
      const res = mockRes();
      const next = vi.fn();

      requireScope('chat')(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Insufficient permissions',
        required_scope: 'chat',
      });
    });
  });
});
