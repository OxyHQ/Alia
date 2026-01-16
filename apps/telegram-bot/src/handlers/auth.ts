import { Context } from 'telegraf';
import crypto from 'crypto';
import { TelegramUser } from '../models/telegram-user';
import { apiClient } from '../services/api-client';

// Generate a random 6-character auth token
function generateAuthToken(): string {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// Helper function to send authentication request
export async function sendAuthRequest(ctx: Context): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  const chatId = ctx.chat?.id.toString();

  if (!telegramId || !chatId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return false;
  }

  // Check if user is already authenticated
  let telegramUser = await TelegramUser.findOne({ telegramId });

  if (telegramUser?.isAuthenticated && telegramUser.sessionToken) {
    // Verify token is still valid
    try {
      await apiClient.getMe(telegramUser.sessionToken);
      return true; // User is authenticated
    } catch (error) {
      // Token is invalid, need to re-authenticate
      telegramUser.isAuthenticated = false;
      telegramUser.sessionToken = undefined;
      await telegramUser.save();
    }
  }

  // Create or update telegram user record
  if (!telegramUser) {
    telegramUser = new TelegramUser({
      telegramId,
      chatId,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
      lastName: ctx.from?.last_name,
    });
  }

  // Generate auth token valid for 15 minutes
  const authToken = generateAuthToken();
  telegramUser.authToken = authToken;
  telegramUser.authTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
  await telegramUser.save();

  const authUrl = apiClient.getAuthURL(authToken);

  await ctx.reply(
    `👋 Hi! To chat with me, please authenticate your Alia account.\n\n` +
    `Click the link below to sign in:\n${authUrl}\n\n` +
    `After signing in, return here and send me a message!\n\n` +
    `_This link expires in 15 minutes._`,
    { parse_mode: 'Markdown' }
  );

  return false; // User is not authenticated
}

export async function handleStart(ctx: Context) {
  const telegramId = ctx.from?.id.toString();

  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  // Check if user is already authenticated
  const telegramUser = await TelegramUser.findOne({ telegramId });

  if (telegramUser?.isAuthenticated && telegramUser.sessionToken) {
    // Verify token is still valid
    try {
      await apiClient.getMe(telegramUser.sessionToken);
      await ctx.reply(
        `Welcome back! You're already authenticated.\n\n` +
        `Just send me a message to start chatting!\n\n` +
        `Commands:\n` +
        `/help - Show available commands\n` +
        `/status - Check your account status\n` +
        `/new - Start a new conversation\n` +
        `/logout - Disconnect your account`
      );
      return;
    } catch (error) {
      // Token is invalid, will request auth below
    }
  }

  // Send auth request
  await sendAuthRequest(ctx);
}

export async function handleLogout(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  const telegramUser = await TelegramUser.findOne({ telegramId });
  if (!telegramUser || !telegramUser.isAuthenticated) {
    await ctx.reply('You are not currently authenticated.');
    return;
  }

  telegramUser.isAuthenticated = false;
  telegramUser.sessionToken = undefined;
  telegramUser.userId = undefined as any;
  telegramUser.conversationId = undefined;
  await telegramUser.save();

  await ctx.reply(
    '👋 You have been logged out successfully.\n\n' +
    'Use /start to authenticate again.'
  );
}

export async function handleStatus(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  const telegramUser = await TelegramUser.findOne({ telegramId });
  if (!telegramUser || !telegramUser.isAuthenticated || !telegramUser.sessionToken) {
    await ctx.reply(
      '❌ Not authenticated\n\n' +
      'Use /start to authenticate.'
    );
    return;
  }

  try {
    const user = await apiClient.getMe(telegramUser.sessionToken);
    const credits = await apiClient.getCredits(telegramUser.sessionToken);

    await ctx.reply(
      `✅ Account Status\n\n` +
      `Name: ${user.firstName || user.name || 'User'}\n` +
      `Email: ${user.email}\n` +
      `Credits: ${credits.freeCredits || credits.credits || 0}\n` +
      `Linked: ${telegramUser.linkedAt?.toLocaleDateString() || 'N/A'}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    await ctx.reply(
      '❌ Unable to fetch account status.\n\n' +
      'Your session may have expired. Please /logout and /start again.'
    );
  }
}
