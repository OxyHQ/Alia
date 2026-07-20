// packages/api/src/routes/__tests__/webhooks-perbot.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// webhooks.ts pulls in the full LLM/credits/channel pipeline. We only exercise
// the two pure helpers, so every heavy dependency is stubbed to keep the import
// side-effect-free (matching the mocking style of the other route tests).
vi.mock('@oxyhq/core/server', () => ({ verifySecret: vi.fn() }));
vi.mock('ai', () => ({ generateText: vi.fn(), stepCountIs: vi.fn() }));
vi.mock('../../lib/channels/registry.js', () => ({ getChannel: vi.fn() }));
vi.mock('../../lib/chat-core.js', () => ({
  resolveModel: vi.fn(),
  getAIModel: vi.fn(),
  reportModelUsage: vi.fn(),
  getDefaultAliaModel: vi.fn(),
}));
vi.mock('../../lib/channels/outbound.js', () => ({ sendChannelMessage: vi.fn() }));
vi.mock('../../services/chat.service.js', () => ({ buildChatTools: vi.fn() }));
vi.mock('../../lib/prompt-loader.js', () => ({ loadPrompt: vi.fn() }));
vi.mock('../../models/bot-user.js', () => ({ BotUser: {} }));
vi.mock('../../models/bot.js', () => ({ Bot: {} }));
vi.mock('../../models/agent.js', () => ({ Agent: {} }));
vi.mock('../../models/conversation.js', () => ({ Conversation: {} }));
vi.mock('../../models/message.js', () => ({ Message: {} }));
vi.mock('../../lib/user-credits-helpers.js', () => ({ getOrCreateUserCredits: vi.fn() }));
vi.mock('../../lib/credits-manager.js', () => ({ reserveCredits: vi.fn(), finalizeCredits: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({
  log: {
    webhook: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import { getDeduplicationKey, isBotUserRateLimited } from '../webhooks.js';
import type { ChannelInboundMessage } from '../../lib/channels/types.js';

function makeMessage(over: Partial<ChannelInboundMessage> = {}): ChannelInboundMessage {
  return {
    platformUserId: 'tg-user-1',
    chatId: 'chat-1',
    text: 'hello there',
    ...over,
  };
}

describe('webhooks helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getDeduplicationKey — per-bot scope isolation', () => {
    it('produces DIFFERENT keys for two different scopes with the same channel+user+text', () => {
      const message = makeMessage();
      const keyBotA = getDeduplicationKey('telegram', message, 'bot-A');
      const keyBotB = getDeduplicationKey('telegram', message, 'bot-B');
      expect(keyBotA).not.toBe(keyBotB);
      // Both still embed the shared channel + user + content hash.
      expect(keyBotA.startsWith('telegram:bot-A:tg-user-1:')).toBe(true);
      expect(keyBotB.startsWith('telegram:bot-B:tg-user-1:')).toBe(true);
    });

    it('produces the SAME key for identical channel+scope+user+text', () => {
      const a = getDeduplicationKey('telegram', makeMessage(), 'bot-A');
      const b = getDeduplicationKey('telegram', makeMessage(), 'bot-A');
      expect(a).toBe(b);
    });

    it('produces a different key when no scope is provided vs a scoped call', () => {
      const scoped = getDeduplicationKey('telegram', makeMessage(), 'bot-A');
      const unscoped = getDeduplicationKey('telegram', makeMessage());
      expect(scoped).not.toBe(unscoped);
      expect(unscoped.startsWith('telegram:tg-user-1:')).toBe(true);
    });

    it('produces a different key when the message text differs', () => {
      const a = getDeduplicationKey('telegram', makeMessage({ text: 'one' }), 'bot-A');
      const b = getDeduplicationKey('telegram', makeMessage({ text: 'two' }), 'bot-A');
      expect(a).not.toBe(b);
    });
  });

  describe('isBotUserRateLimited — per (botId, userId) window', () => {
    it('allows the first 15 calls and blocks the 16th within the window', () => {
      const botId = 'rl-bot-1';
      const userId = 'rl-user-1';
      for (let i = 0; i < 15; i++) {
        expect(isBotUserRateLimited(botId, userId)).toBe(false);
      }
      expect(isBotUserRateLimited(botId, userId)).toBe(true);
    });

    it('isolates the limit per (botId, userId) pair', () => {
      const userId = 'rl-user-shared';
      // Exhaust bot-2's budget for this user.
      for (let i = 0; i < 15; i++) {
        expect(isBotUserRateLimited('rl-bot-2', userId)).toBe(false);
      }
      expect(isBotUserRateLimited('rl-bot-2', userId)).toBe(true);

      // A different bot for the SAME user is unaffected.
      expect(isBotUserRateLimited('rl-bot-3', userId)).toBe(false);

      // The same bot for a DIFFERENT user is unaffected.
      expect(isBotUserRateLimited('rl-bot-2', 'rl-user-other')).toBe(false);
    });
  });
});

// NOTE: The per-bot route branch in `POST /:type` (unknown
// x-telegram-bot-api-secret-token falling through to the generic path) is NOT
// exercised here. Reaching that decision requires the full inbound pipeline —
// getChannel().webhook.parse, Bot/BotUser lookups, credits reserve/finalize and
// generateText — and distinguishing "fell through" from "short-circuited" means
// running the entire generic LLM flow. Per the task's guidance that is out of
// scope; the scope-isolation + rate-limit helper units above are the priority.
