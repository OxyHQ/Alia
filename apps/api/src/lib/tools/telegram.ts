import { tool } from 'ai';
import { z } from 'zod';
import { TelegramUser } from '../../models/telegram-user.js';

/**
 * Create sendTelegramMessage tool for a specific user
 * Allows AI to send Telegram messages to the user
 */
export function createSendTelegramTool(userId: string) {
  return tool({
    description: 'Send a Telegram message to the user. Use this when the user explicitly asks to receive a message or reminder on Telegram.',
    inputSchema: z.object({
      message: z.string().describe('The message to send to the user on Telegram'),
    }),
    execute: async ({ message }) => {
      try {
        // Find user's Telegram account
        const telegramUser = await TelegramUser.findOne({
          userId,
          isAuthenticated: true
        });

        if (!telegramUser || !telegramUser.chatId) {
          return {
            success: false,
            message: 'User does not have a linked Telegram account'
          };
        }

        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) {
          return {
            success: false,
            message: 'Telegram bot not configured'
          };
        }

        // Send message via Telegram API
        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: telegramUser.chatId,
            text: message,
            parse_mode: 'HTML',
          }),
        });

        const result = await response.json();

        if (!response.ok) {
          console.error('[SendTelegram] Failed to send message:', result);
          return {
            success: false,
            message: `Failed to send Telegram: ${result.description || 'Unknown error'}`
          };
        }

        console.log('[SendTelegram] Message sent successfully to:', telegramUser.telegramId);
        return {
          success: true,
          message: 'Telegram message sent successfully'
        };
      } catch (error: any) {
        console.error('[SendTelegram] Error:', error);
        return {
          success: false,
          message: `Error sending Telegram: ${error.message}`
        };
      }
    },
  });
}
