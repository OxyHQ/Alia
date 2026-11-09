import { createHash } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { findLinkedBotUser, findSystemBot } from '../../db/integrations/botRepository.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';
import { markdownToTelegramHtml, stripMarkdown } from '../channels/telegram-format.js';
import { getRedisClient } from '../redis.js';

/** How long a run's sent messages are remembered: past any retry of that run. */
const SENT_MARK_TTL_SECONDS = 24 * 60 * 60;

/**
 * Claim the right to send `message` for this run, once. A run the queue retries after a failure part-way
 * would otherwise send everything it already sent: a Telegram message cannot be taken back. `SET NX` is
 * atomic across instances. True: send it. False: this run already sent exactly this text.
 *
 * The caller releases the claim when the send does not succeed, so the retry the claim exists for can
 * actually send it. Without Redis (development) there is nothing to claim against and the send
 * proceeds; with Redis down the claim fails open, because a missed alert is worse than a repeated one.
 */
async function claimSend(
  runId: string,
  userId: string,
  message: string,
): Promise<{ claimed: false } | { claimed: true; release: () => Promise<void> }> {
  const redis = getRedisClient();
  const nothingToRelease = { claimed: true as const, release: async () => undefined };
  if (!redis) return nothingToRelease;
  const digest = createHash('sha256').update(message).digest('hex').slice(0, 32);
  const key = `alia:tg-sent:${runId}:${userId}:${digest}`;
  try {
    const set = await redis.set(key, '1', 'EX', SENT_MARK_TTL_SECONDS, 'NX');
    if (set !== 'OK') return { claimed: false };
    return {
      claimed: true,
      release: async () => {
        await redis.del(key).catch(() => undefined);
      },
    };
  } catch (error: unknown) {
    log.tools.warn({ err: error, runId }, 'Could not claim a Telegram send; sending anyway');
    return nothingToRelease;
  }
}

/**
 * Create sendTelegramMessage tool for a specific user.
 * Uses the system Telegram BOT to send messages on behalf of the user.
 * This is the "active send" path — Connected Accounts are passive only.
 */
export function createSendTelegramTool(userId: string, runId?: string) {
  return tool({
    description:
      'Send a message to the user\'s Telegram. ONLY when they explicitly ask ("send me X on Telegram").',
    inputSchema: z.object({
      message: z.string().describe('The complete message'),
    }),
    execute: async ({ message }) => {
      // A run that is retried does not send again what it already sent.
      if (runId === undefined) return sendOnce(message);
      const claim = await claimSend(runId, userId, message);
      if (!claim.claimed) {
        return { success: true, message: 'Telegram message already sent in this run' };
      }
      const result = await sendOnce(message);
      if (!result.success) await claim.release();
      return result;
    },
  });

  async function sendOnce(message: string): Promise<{ success: boolean; message: string }> {
    try {
      // Find the system Telegram bot (never a user-registered one), then the user's linked account
      const db = getDb();
      const bot = await findSystemBot(db, 'telegram', { activeOnly: true });
      if (!bot) {
        return { success: false, message: 'Telegram bot not configured' };
      }

      const botUser = await findLinkedBotUser(db, bot.id, userId);

      if (!botUser || !botUser.chatId) {
        return {
          success: false,
          message: 'User does not have a linked Telegram account',
        };
      }

      const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
      if (!botToken) {
        return {
          success: false,
          message: 'Telegram bot not configured',
        };
      }

      // Convert Markdown to Telegram HTML and send
      const htmlMessage = markdownToTelegramHtml(message);

      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: botUser.chatId,
          text: htmlMessage,
          parse_mode: 'HTML',
        }),
      });

      if (!response.ok) {
        const result = (await response.json()) as { ok?: boolean; description?: string };

        // If HTML parsing failed, retry as plain text
        if (response.status === 400) {
          const fallback = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: botUser.chatId, text: stripMarkdown(message) }),
          });

          if (fallback.ok) {
            log.tools.info(
              { platformUserId: botUser.platformUserId },
              'Telegram message sent (plain text fallback)',
            );
            return { success: true, message: 'Telegram message sent successfully' };
          }
        }

        log.tools.error(
          { err: result, chatId: botUser.chatId, tokenPrefix: botToken.slice(0, 5) },
          'Telegram sendMessage failed',
        );
        return {
          success: false,
          message: `Failed to send Telegram: ${result.description || 'Unknown error'}`,
        };
      }

      log.tools.info(
        { platformUserId: botUser.platformUserId },
        'Telegram message sent successfully',
      );
      return {
        success: true,
        message: 'Telegram message sent successfully',
      };
    } catch (error: unknown) {
      log.tools.error({ err: error }, 'Error');
      return {
        success: false,
        message: `Error sending Telegram: ${getErrorMessage(error)}`,
      };
    }
  }
}
