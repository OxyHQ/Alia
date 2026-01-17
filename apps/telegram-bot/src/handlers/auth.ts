import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { apiClient } from '../services/api-client';

// Handle sign-in flow from deep link
async function handleSignInFlow(ctx: Context, authCode: string, telegramId: string, chatId: string) {
  try {
    await ctx.reply(
      '🔐 <b>Signing you in...</b>\n\n' +
      'Please wait while we authenticate your account.',
      { parse_mode: 'HTML' }
    );

    // Complete the sign-in on the backend
    const result = await apiClient.completeSignIn({
      authCode,
      telegramId,
      chatId,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
      lastName: ctx.from?.last_name,
    });

    if (result.success) {
      const userName = result.user?.name || ctx.from?.first_name || 'there';
      const welcomeMessage = result.isNewUser
        ? `🎉 <b>Welcome to Alia, ${userName}!</b>\n\n` +
          `Your account has been created and your Telegram is linked.\n\n` +
          `You now have <b>1000 free credits</b> to get started!\n\n` +
          `Just send me any message to start chatting. 💬`
        : `👋 <b>Welcome back, ${userName}!</b>\n\n` +
          `You're now signed in and ready to chat.\n\n` +
          `Just send me any message to continue! 💬`;

      await ctx.reply(welcomeMessage, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('📊 Account Status', 'status'),
            Markup.button.callback('🆕 New Chat', 'new')
          ],
          [
            Markup.button.callback('📚 History', 'history'),
            Markup.button.callback('❓ Help', 'help')
          ]
        ])
      });
    } else {
      await ctx.reply(
        '❌ <b>Sign-in failed</b>\n\n' +
        'Unable to complete the authentication process.\n\n' +
        'Please try again or use /start for a new authentication link.',
        { parse_mode: 'HTML' }
      );
    }
  } catch (error) {
    console.error('Sign-in flow error:', error);
    await ctx.reply(
      '❌ <b>Authentication Error</b>\n\n' +
      'Something went wrong during sign-in.\n\n' +
      'Please try again later or use /start.',
      { parse_mode: 'HTML' }
    );
  }
}

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

  // Check if this is a sign-in flow from deep link
  // Deep link format: /start signin_AUTHCODE
  const startPayload = (ctx as any).message?.text?.split(' ')[1];
  if (startPayload && startPayload.startsWith('signin_')) {
    const authCode = startPayload.replace('signin_', '');
    await handleSignInFlow(ctx, authCode, telegramId, chatId);
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

    // Si ya está vinculado, ofrecer login directo
    if (telegramUser.isAuthenticated && telegramUser.sessionToken) {
      // Verificar si el token sigue siendo válido
      try {
        const response = await apiClient.getMe(telegramUser.sessionToken);
        const userData = response.user || response;
        // Ofrecer login directo con enlace
        const authData = await apiClient.requestTelegramAuth(telegramId);
        await ctx.reply(
          `👋 <b>Welcome back, ${userData.name || 'there'}!</b>\n\n` +
          `✅ Your Telegram is already linked to an Alia account.\n\n` +
          `You can sign in directly using the button below.`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url('🔐 Sign In to Alia', authData.authUrl)],
              [Markup.button.callback('🆕 New Chat', 'new')],
              [Markup.button.callback('🚪 Logout', 'logout')]
            ])
          }
        );
        return;
      } catch (error) {
        // Token inválido, continuar con login
      }
    }

    // Si NO está vinculado, ofrecer vinculación o login
    await ctx.reply(
      `👋 <b>Welcome to Alia AI!</b>\n\n` +
      `You can:\n` +
      `- <b>Link your Telegram to an existing Alia account</b> (if you already have one)\n` +
      `- <b>Create a new Alia account with Telegram</b>\n\n` +
      `Choose an option below:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('🔗 Link to Existing Account', (await apiClient.requestTelegramLink(telegramId)).authUrl)],
          [Markup.button.url('🆕 Create/Sign In with Telegram', (await apiClient.requestTelegramAuth(telegramId)).authUrl)]
        ])
      }
    );
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
      const response = await apiClient.getMe(telegramUser.sessionToken);
      const userData = response.user || response; // Handle both nested and flat responses
      const credits = await apiClient.getCredits(telegramUser.sessionToken);

      const creditsValue = credits.freeCredits || credits.credits || 0;
      const creditsEmoji = creditsValue > 500 ? '🟢' : creditsValue > 100 ? '🟡' : '🔴';

      await ctx.reply(
        `📊 <b>Account Status</b>\n\n` +
        `👤 <b>Name:</b> ${userData.name || 'Not set'}\n` +
        `📧 <b>Email:</b> ${userData.email || 'Not set'}\n` +
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
