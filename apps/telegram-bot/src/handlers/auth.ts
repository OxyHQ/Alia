import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { apiClient } from '../services/api-client';

// Helper function to send authentication request
export async function sendAuthRequest(ctx: Context): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  const chatId = ctx.chat?.id.toString();

  if (!telegramId || !chatId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return false;
  }

  try {
    // Get or create telegram user
    let telegramUser = await apiClient.getTelegramUser(telegramId);

    if (!telegramUser) {
      telegramUser = await apiClient.createOrUpdateTelegramUser({
        telegramId,
        chatId,
        username: ctx.from?.username,
        firstName: ctx.from?.first_name,
        lastName: ctx.from?.last_name,
      });
    }

    // Check if user is already authenticated
    if (telegramUser.isAuthenticated && telegramUser.sessionToken) {
      // Verify token is still valid
      try {
        await apiClient.getMe(telegramUser.sessionToken);
        return true; // User is authenticated
      } catch (error) {
        // Token is invalid, continue with auth request
      }
    }

    // Request new auth token
    const authData = await apiClient.requestTelegramAuth(telegramId);

    await ctx.reply(
      `👋 <b>Welcome to Alia AI!</b>\n\n` +
      `To get started, please authenticate your account.\n\n` +
      `Click the button below to sign in through the Alia app.\n\n` +
      `<i>⏱ This link expires in 15 minutes</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('🔐 Sign In to Alia', authData.authUrl)],
        ])
      }
    );

    return false; // User is not authenticated
  } catch (error) {
    console.error('Auth request error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
    return false;
  }
}

export async function handleStart(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  const chatId = ctx.chat?.id.toString();

  if (!telegramId || !chatId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    // Get or create telegram user
    let telegramUser = await apiClient.getTelegramUser(telegramId);

    if (!telegramUser) {
      telegramUser = await apiClient.createOrUpdateTelegramUser({
        telegramId,
        chatId,
        username: ctx.from?.username,
        firstName: ctx.from?.first_name,
        lastName: ctx.from?.last_name,
      });
    }

    // Check if user is already authenticated
    if (telegramUser.isAuthenticated && telegramUser.sessionToken) {
      // Verify token is still valid
      try {
        const user = await apiClient.getMe(telegramUser.sessionToken);
        await ctx.reply(
          `👋 <b>Welcome back, ${user.firstName || user.name || 'there'}!</b>\n\n` +
          `✅ You're already authenticated and ready to chat.\n\n` +
          `Just send me any message to start a conversation!`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('📊 Account Status', 'status'),
                Markup.button.callback('🆕 New Chat', 'new')
              ],
              [
                Markup.button.callback('📚 History', 'history'),
                Markup.button.callback('❓ Help', 'help')
              ],
              [Markup.button.callback('🚪 Logout', 'logout')]
            ])
          }
        );
        return;
      } catch (error) {
        // Token is invalid, will request auth below
      }
    }

    // Send auth request
    await sendAuthRequest(ctx);
  } catch (error) {
    console.error('Start command error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
  }
}

export async function handleLogout(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    const telegramUser = await apiClient.getTelegramUser(telegramId);

    if (!telegramUser || !telegramUser.isAuthenticated) {
      await ctx.reply('You are not currently authenticated.');
      return;
    }

    await apiClient.logoutTelegram(telegramId);

    await ctx.reply(
      '👋 <b>Logged Out Successfully</b>\n\n' +
      'Your Telegram account has been disconnected from Alia.\n\n' +
      'Use /start whenever you want to sign in again.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔐 Sign In Again', 'start')]
        ])
      }
    );
  } catch (error) {
    console.error('Logout error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
  }
}

export async function handleStatus(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    const telegramUser = await apiClient.getTelegramUser(telegramId);

    if (!telegramUser || !telegramUser.isAuthenticated || !telegramUser.sessionToken) {
      await sendAuthRequest(ctx);
      return;
    }

    try {
      const user = await apiClient.getMe(telegramUser.sessionToken);
      const credits = await apiClient.getCredits(telegramUser.sessionToken);

      const creditsValue = credits.freeCredits || credits.credits || 0;
      const creditsEmoji = creditsValue > 500 ? '🟢' : creditsValue > 100 ? '🟡' : '🔴';

      await ctx.reply(
        `📊 <b>Account Status</b>\n\n` +
        `👤 <b>Name:</b> ${user.firstName || user.name || 'User'}\n` +
        `📧 <b>Email:</b> ${user.email || 'Not set'}\n` +
        `${creditsEmoji} <b>Credits:</b> ${creditsValue}\n` +
        `🔗 <b>Linked:</b> ${telegramUser.linkedAt ? new Date(telegramUser.linkedAt).toLocaleDateString() : 'N/A'}`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh', 'status')],
            [Markup.button.callback('« Back', 'start')]
          ])
        }
      );
    } catch (error) {
      await ctx.reply(
        '❌ <b>Unable to fetch account status</b>\n\n' +
        'Your session may have expired.\n' +
        'Please /logout and /start again.',
        { parse_mode: 'HTML' }
      );
    }
  } catch (error) {
    console.error('Status error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
  }
}
