import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing credits-manager
vi.mock('../../models/user-credits.js', () => ({
  UserCredits: {
    findById: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('../chat-core.js', () => ({
  getClarityModel: vi.fn().mockResolvedValue({ creditMultiplier: 1 }),
}));

vi.mock('../logger.js', () => ({
  log: {
    credits: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

import { UserCredits } from '../../models/user-credits.js';
import {
  reserveCredits,
  finalizeCredits,
  finalizeVoiceCredits,
  refundReservation,
  safeRefund,
  calculateCreditsFromTokens,
  calculateCreditsFromMinutes,
  getUserCredits,
  CREDITS_CONFIG,
  type CreditReservation,
} from '../credits-manager.js';

const mockUserCredits = UserCredits as any;

function makeCreditsDoc(free: number, paid: number) {
  return { credits: { free, paid }, _id: 'user-1' };
}

describe('credits-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('calculateCreditsFromTokens', () => {
    it('returns minimum credits for 0 tokens', async () => {
      expect(await calculateCreditsFromTokens(0)).toBe(CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST);
    });

    it('calculates credits from token count', async () => {
      // 5000 tokens / 1000 tokens per credit = 5 credits
      expect(await calculateCreditsFromTokens(5000)).toBe(5);
    });

    it('rounds up partial credits', async () => {
      // 1500 tokens / 1000 = 1.5 → ceil = 2
      expect(await calculateCreditsFromTokens(1500)).toBe(2);
    });

    it('subtracts system prompt tokens', async () => {
      // 5000 total - 3000 system = 2000 billable / 1000 = 2
      expect(await calculateCreditsFromTokens(5000, undefined, 3000)).toBe(2);
    });

    it('floors billable tokens at 0 when system > total', async () => {
      // 1000 total - 5000 system = max(0, -4000) = 0 → min 1
      expect(await calculateCreditsFromTokens(1000, undefined, 5000)).toBe(CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST);
    });

    it('enforces minimum credits', async () => {
      // 1 token → 0.001 → ceil = 1 → max(1, 1) = 1
      expect(await calculateCreditsFromTokens(1)).toBe(1);
    });
  });

  describe('calculateCreditsFromMinutes', () => {
    it('returns minimum credits for 0 minutes', async () => {
      expect(await calculateCreditsFromMinutes(0, 'clarity-v1', 0.05)).toBe(CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST);
    });

    it('calculates credits from minutes', async () => {
      // 2 min * $0.05/min * 1000 = 100 credits
      expect(await calculateCreditsFromMinutes(2, 'clarity-v1', 0.05)).toBe(100);
    });

    it('rounds up partial credits', async () => {
      // 0.5 min * $0.05/min * 1000 = 25 credits
      expect(await calculateCreditsFromMinutes(0.5, 'clarity-v1', 0.05)).toBe(25);
    });
  });

  describe('reserveCredits', () => {
    it('reserves credits successfully', async () => {
      mockUserCredits.findOneAndUpdate.mockResolvedValue(makeCreditsDoc(9, 10));

      const result = await reserveCredits('user-1', 1);

      expect(result).toEqual({
        userId: 'user-1',
        creditsReserved: 1,
        initialFreeCredits: 9,
        initialPaidCredits: 10,
      });
    });

    it('returns null for insufficient credits', async () => {
      mockUserCredits.findOneAndUpdate.mockResolvedValue(null);

      const result = await reserveCredits('user-1', 100);
      expect(result).toBeNull();
    });

    it('throws on database error', async () => {
      mockUserCredits.findOneAndUpdate.mockRejectedValue(new Error('DB error'));

      await expect(reserveCredits('user-1', 1)).rejects.toThrow('DB error');
    });
  });

  describe('finalizeCredits', () => {
    const reservation: CreditReservation = {
      userId: 'user-1',
      creditsReserved: 5,
      initialFreeCredits: 10,
      initialPaidCredits: 10,
    };

    it('refunds excess when actual < reserved', async () => {
      // reserved 5, actual 2 → refund 3
      mockUserCredits.findById.mockResolvedValue(makeCreditsDoc(5, 10));
      mockUserCredits.findByIdAndUpdate.mockResolvedValue(makeCreditsDoc(8, 10));

      const result = await finalizeCredits(reservation, {
        promptTokens: 1000,
        completionTokens: 1000,
        totalTokens: 2000,
        systemPromptTokens: 0,
      });

      expect(result.creditsCharged).toBe(2);
      expect(result.creditsRemaining).toBe(18);
    });

    it('charges more when actual > reserved', async () => {
      // reserved 5, actual 10 → charge 5 more
      mockUserCredits.findById.mockResolvedValue(makeCreditsDoc(5, 10));
      mockUserCredits.findOneAndUpdate.mockResolvedValue(makeCreditsDoc(0, 10));

      const result = await finalizeCredits(reservation, {
        promptTokens: 5000,
        completionTokens: 5000,
        totalTokens: 10000,
        systemPromptTokens: 0,
      });

      expect(result.creditsCharged).toBe(10);
      expect(result.creditsRemaining).toBe(10);
    });

    it('sets credits to 0 when insufficient for additional charge', async () => {
      mockUserCredits.findById.mockResolvedValue(makeCreditsDoc(0, 2));
      // First findOneAndUpdate returns null (insufficient)
      mockUserCredits.findOneAndUpdate.mockResolvedValue(null);
      // Then sets to 0
      mockUserCredits.findByIdAndUpdate.mockResolvedValue(makeCreditsDoc(0, 0));

      const result = await finalizeCredits(reservation, {
        promptTokens: 50000,
        completionTokens: 50000,
        totalTokens: 100000,
        systemPromptTokens: 0,
      });

      expect(result.creditsCharged).toBe(100);
      expect(result.creditsRemaining).toBe(0);
    });

    it('throws when user not found', async () => {
      mockUserCredits.findById.mockResolvedValue(null);

      await expect(
        finalizeCredits(reservation, {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 1000,
          systemPromptTokens: 0,
        })
      ).rejects.toThrow('User credits not found');
    });
  });

  describe('finalizeVoiceCredits', () => {
    const reservation: CreditReservation = {
      userId: 'user-1',
      creditsReserved: 100,
      initialFreeCredits: 500,
      initialPaidCredits: 500,
    };

    it('refunds excess when actual < reserved', async () => {
      // reserved 100, actual: 0.5 min * $0.05/min * 1000 = 25
      mockUserCredits.findById.mockResolvedValue(makeCreditsDoc(400, 500));
      mockUserCredits.findByIdAndUpdate.mockResolvedValue(makeCreditsDoc(475, 500));

      const result = await finalizeVoiceCredits(reservation, 0.5, 'clarity-v1', 0.05);

      expect(result.creditsCharged).toBe(25);
      expect(result.creditsRemaining).toBe(975);
    });
  });

  describe('refundReservation', () => {
    it('refunds all reserved credits', async () => {
      mockUserCredits.findByIdAndUpdate.mockResolvedValue(makeCreditsDoc(15, 10));

      await refundReservation({
        userId: 'user-1',
        creditsReserved: 5,
        initialFreeCredits: 10,
        initialPaidCredits: 10,
      });

      expect(mockUserCredits.findByIdAndUpdate).toHaveBeenCalledWith(
        'user-1',
        { $inc: { 'credits.free': 5 } },
        { runValidators: false }
      );
    });

    it('does not throw on database error (logs instead)', async () => {
      mockUserCredits.findByIdAndUpdate.mockRejectedValue(new Error('DB error'));

      // Should not throw
      await refundReservation({
        userId: 'user-1',
        creditsReserved: 5,
        initialFreeCredits: 10,
        initialPaidCredits: 10,
      });
    });
  });

  describe('safeRefund', () => {
    it('does nothing for null reservation', async () => {
      await safeRefund(null);
      expect(mockUserCredits.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('refunds valid reservation', async () => {
      mockUserCredits.findByIdAndUpdate.mockResolvedValue(makeCreditsDoc(15, 10));

      await safeRefund({
        userId: 'user-1',
        creditsReserved: 5,
        initialFreeCredits: 10,
        initialPaidCredits: 10,
      }, 'test reason');

      expect(mockUserCredits.findByIdAndUpdate).toHaveBeenCalled();
    });
  });

  describe('getUserCredits', () => {
    it('returns credits for existing user', async () => {
      mockUserCredits.findById.mockResolvedValue(makeCreditsDoc(10, 20));

      const result = await getUserCredits('user-1');
      expect(result).toEqual({ free: 10, paid: 20, total: 30 });
    });

    it('returns null for non-existent user', async () => {
      mockUserCredits.findById.mockResolvedValue(null);

      const result = await getUserCredits('nonexistent');
      expect(result).toBeNull();
    });

    it('returns null on database error', async () => {
      mockUserCredits.findById.mockRejectedValue(new Error('DB error'));

      const result = await getUserCredits('user-1');
      expect(result).toBeNull();
    });
  });
});
