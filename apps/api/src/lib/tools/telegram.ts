import { tool } from 'ai';
import { z } from 'zod';
import mongoose from 'mongoose';
import { ChannelUser } from '../../models/channel-user.js';
import { log } from '../logger.js';

/**
 * Create sendTelegramMessage tool for a specific user
 * Allows AI to send Telegram messages to the user
 */
export function createSendTelegramTool(userId: string) {
  return tool({
    description: 'Send a message to user\'s Telegram. Use ONLY when user explicitly requests (e.g., "send me X on Telegram", "remind me via Telegram").',
    inputSchema: z.object({
      message: z.string().describe('Complete message to send to user on Telegram'),
    }),
    execute: async ({ message }) => {
      try {
        // Find user's Telegram account
        const channelUser = await ChannelUser.findOne({
          channelType: 'telegram',
          oxyUserId: new mongoose.Types.ObjectId(userId),
          isAuthenticated: true
        });

        if (!channelUser || !channelUser.chatId) {
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
            chat_id: channelUser.chatId,
            text: message,
            parse_mode: 'HTML',
          }),
        });

        const result = await response.json() as { ok?: boolean; description?: string };

        if (!response.ok) {
          log.tools.error({ err: result }, 'Failed to send message');
          return {
            success: false,
            message: `Failed to send Telegram: ${result.description || 'Unknown error'}`
          };
        }

        log.tools.info({ channelUserId: channelUser.channelUserId }, 'Telegram message sent successfully');
        return {
          success: true,
          message: 'Telegram message sent successfully'
        };
      } catch (error: any) {
        log.tools.error({ err: error }, 'Error');
        return {
          success: false,
          message: `Error sending Telegram: ${error.message}`
        };
      }
    },
  });
}
