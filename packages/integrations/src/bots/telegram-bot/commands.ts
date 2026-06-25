/**
 * Telegram Bot command handlers — adapted from apps/telegram-bot/src/handlers/.
 *
 * Uses the shared APIClient (channels API) instead of the legacy /telegram/ routes.
 */

import { Context, Markup } from 'telegraf';
import { v4 as uuidv4 } from 'uuid';
import { APIClient, type ModelInfo } from '../../shared/api-client';

const apiClient = new APIClient('telegram', process.env.TELEGRAM_BOT_SECRET || '');

// ---------------------------------------------------------------------------
// Model cache
// ---------------------------------------------------------------------------
let cachedModels: ModelInfo[] = [];
let lastFetchTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getModels() {
  if (cachedModels.length === 0 || Date.now() - lastFetchTime > CACHE_TTL_MS) {
    cachedModels = await apiClient.fetchModels();
    lastFetchTime = Date.now();
  }
  return cachedModels;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/** Ensure the bot user exists, then generate an auth-request link. */
export async function sendAuthRequest(ctx: Context): Promise<boolean> {
  const telegramId = ctx.from?.id.toString();
  const chatId = ctx.chat?.id.toString();
  if (!telegramId || !chatId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return false;
  }

  try {
    // Ensure bot user exists
    let botUser = await apiClient.getBotUser(telegramId);
    if (!botUser) {
      botUser = await apiClient.createOrUpdateBotUser({
        platformUserId: telegramId,
        chatId,
        displayName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || undefined,
      });
    }

    // Already authenticated?
    if (botUser.isLinked) {
      return true;
    }

    // Request auth token
    const { authUrl } = await apiClient.requestAuthToken(telegramId);

    await ctx.reply(
      `👋 <b>Welcome to Alia AI!</b>\n\n` +
      `To get started, please authenticate your account.\n\n` +
      `Click the button below to sign in through the Alia app.\n\n` +
      `<i>⏱ This link expires in 15 minutes</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('🔐 Sign In to Alia', authUrl)],
        ]),
      },
    );

    return false;
  } catch (error) {
    console.error('[Telegram Bot] Auth request error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
    return false;
  }
}

// ---------------------------------------------------------------------------
// /start
// ---------------------------------------------------------------------------
export async function handleStart(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  const chatId = ctx.chat?.id.toString();
  if (!telegramId || !chatId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    // Ensure bot user exists
    let botUser = await apiClient.getBotUser(telegramId);
    if (!botUser) {
      botUser = await apiClient.createOrUpdateBotUser({
        platformUserId: telegramId,
        chatId,
        displayName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || undefined,
      });
    }

    // Already linked & authenticated
    if (botUser.isLinked) {
      const displayName = botUser.displayName || ctx.from?.first_name || 'there';
      await ctx.reply(
        `👋 <b>Welcome back, ${displayName}!</b>\n\n` +
        `✅ Your Telegram is already linked to your Alia account.\n\n` +
        `You're all set! Just send me a message to start chatting. 💬`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🆕 New Chat', 'new')],
            [Markup.button.callback('📊 Account Status', 'status')],
            [Markup.button.callback('🚪 Disconnect', 'logout')],
          ]),
        },
      );
      return;
    }

    // Not linked — offer sign-in
    const { authUrl } = await apiClient.requestAuthToken(telegramId);
    await ctx.reply(
      `👋 <b>Welcome to Alia AI!</b>\n\n` +
      `To use Alia on Telegram, you need to link your Telegram to your existing Alia account.\n\n` +
      `Don't have an Alia account yet? Create one at <b>alia.onl</b> first, then come back here to link it!\n\n` +
      `<i>⏱ This link expires in 15 minutes</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('🔗 Link to Existing Account', authUrl)],
          [Markup.button.url('🌐 Create Account at alia.onl', 'https://alia.onl')],
        ]),
      },
    );
  } catch (error) {
    console.error('[Telegram Bot] Start command error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
  }
}

// ---------------------------------------------------------------------------
// /logout
// ---------------------------------------------------------------------------
export async function handleLogout(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    const botUser = await apiClient.getBotUser(telegramId);
    if (!botUser || !botUser.isLinked) {
      await ctx.reply('You are not currently authenticated.');
      return;
    }

    await apiClient.logoutUser(telegramId);

    await ctx.reply(
      '👋 <b>Logged Out Successfully</b>\n\n' +
      'Your Telegram account has been disconnected from Alia.\n\n' +
      'Use /start whenever you want to sign in again.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔐 Sign In Again', 'start')],
        ]),
      },
    );
  } catch (error) {
    console.error('[Telegram Bot] Logout error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
  }
}

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------
export async function handleStatus(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    const botUser = await apiClient.getBotUser(telegramId);
    if (!botUser || !botUser.isLinked) {
      await sendAuthRequest(ctx);
      return;
    }

    const displayName = botUser.displayName || botUser.username || 'Not set';

    await ctx.reply(
      `📊 <b>Account Status</b>\n\n` +
      `👤 <b>Name:</b> ${displayName}\n` +
      `✅ <b>Status:</b> Connected\n` +
      `🤖 <b>Model:</b> ${botUser.preferredModel || 'alia-lite'}\n` +
      `🔗 <b>Linked:</b> ${botUser.linkedAt ? new Date(botUser.linkedAt).toLocaleDateString() : 'N/A'}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh', 'status')],
          [Markup.button.callback('« Back', 'start')],
        ]),
      },
    );
  } catch (error) {
    console.error('[Telegram Bot] Status error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
  }
}

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------
export async function handleHelp(ctx: Context) {
  const helpMessage = `
🤖 <b>Alia AI Bot - Help Guide</b>

<b>📌 Getting Started:</b>
• /start - Authenticate your account
• /status - Check account & credits
• /logout - Disconnect your account

<b>💬 Chatting:</b>
• Just send me any message to chat!
• /new - Start a fresh conversation
• /history - View past conversations
• /model - Change AI model

<b>❓ Need Help?</b>
• /help - Show this help message

<b>🎯 How It Works:</b>
1️⃣ Send /start to begin
2️⃣ Click the sign-in button
3️⃣ Authenticate in the Alia app
4️⃣ Return and start chatting!

<b>💡 Example:</b>
<i>You:</i> Hello, who are you?
<i>Alia:</i> I'm Alia, your AI assistant! How can I help you today?
`;

  await ctx.reply(helpMessage, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('🚀 Get Started', 'start'),
        Markup.button.callback('📊 My Status', 'status'),
      ],
      [Markup.button.url('🌐 Visit Alia App', 'https://alia.onl')],
    ]),
  });
}

// ---------------------------------------------------------------------------
// /model + model selection callback
// ---------------------------------------------------------------------------
export async function handleModel(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    const botUser = await apiClient.getBotUser(telegramId);
    if (!botUser || !botUser.isLinked) {
      await ctx.reply(
        '🔒 <b>Authentication Required</b>\n\n' +
        'Please sign in first to change your AI model.',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔐 Sign In', 'start')],
          ]),
        },
      );
      return;
    }

    const models = await getModels();
    if (models.length === 0) {
      await ctx.reply('❌ Unable to fetch available models. Please try again later.');
      return;
    }

    const currentModel = botUser.preferredModel || 'alia-lite';
    let message = '🤖 <b>Choose AI Model</b>\n\n';
    const currentInfo = models.find(m => m.id === currentModel);
    message += `<b>Current Model:</b> ${currentInfo?.emoji || '🤖'} ${currentInfo?.name || currentModel}\n\n`;
    message += '<b>Available Models:</b>\n';

    for (const model of models) {
      const current = model.id === currentModel ? ' ✓' : '';
      message += `\n${model.emoji || '🤖'} <b>${model.name}</b>${current}\n`;
      message += `   <i>${model.description} (${model.pricing?.credit_multiplier ?? 1}x credits)</i>`;
    }

    // Build button rows (2 per row)
    const buttonRows: ReturnType<typeof Markup.button.callback>[][] = [];
    let currentRow: ReturnType<typeof Markup.button.callback>[] = [];
    for (const model of models) {
      currentRow.push(Markup.button.callback(
        `${model.emoji || '🤖'} ${model.name}`,
        `model_${model.id}`,
      ));
      if (currentRow.length === 2) {
        buttonRows.push(currentRow);
        currentRow = [];
      }
    }
    if (currentRow.length > 0) buttonRows.push(currentRow);
    buttonRows.push([Markup.button.callback('« Back', 'start')]);

    await ctx.reply(message, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttonRows),
    });
  } catch (error) {
    console.error('[Telegram Bot] Model command error:', error);
    await ctx.reply('❌ Error loading model settings. Please try again.');
  }
}

export async function handleModelSelection(ctx: Context, modelId: string) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.answerCbQuery('Unable to identify you');
    return;
  }

  try {
    await apiClient.updateModel(telegramId, modelId);

    const models = await getModels();
    const info = models.find(m => m.id === modelId);

    await ctx.answerCbQuery(`Model changed to ${info?.name || modelId}`);
    await ctx.reply(
      `${info?.emoji || '🤖'} <b>Model Updated</b>\n\n` +
      `Your AI model has been changed to <b>${info?.name || modelId}</b>.\n\n` +
      `All future conversations will use this model.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back to Menu', 'start')],
        ]),
      },
    );
  } catch (error) {
    console.error('[Telegram Bot] Model selection error:', error);
    await ctx.answerCbQuery('Error updating model');
    await ctx.reply('❌ Error updating model. Please try again.');
  }
}

// ---------------------------------------------------------------------------
// /new — start a new conversation
// ---------------------------------------------------------------------------
export async function handleNewConversation(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    const botUser = await apiClient.getBotUser(telegramId);
    if (!botUser || !botUser.isLinked) {
      await sendAuthRequest(ctx);
      return;
    }

    const newConversationId = uuidv4();
    await apiClient.updateConversation(telegramId, newConversationId);

    await ctx.reply(
      '✨ <b>New Conversation Started!</b>\n\n' +
      'Your previous conversation has been saved.\n' +
      'Send me any message to begin chatting in this new conversation.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📚 View History', 'history')],
        ]),
      },
    );
  } catch (error) {
    console.error('[Telegram Bot] New conversation error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
  }
}

// ---------------------------------------------------------------------------
// /history — view recent conversations
// ---------------------------------------------------------------------------
export async function handleHistory(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    const botUser = await apiClient.getBotUser(telegramId);
    if (!botUser || !botUser.isLinked || !botUser.oxyUserId) {
      await sendAuthRequest(ctx);
      return;
    }

    try {
      const conversations = await apiClient.getConversations(botUser.oxyUserId);
      if (!conversations || conversations.length === 0) {
        await ctx.reply(
          '📚 <b>No Conversations Yet</b>\n\n' +
          'Start chatting with me to create your first conversation!',
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('« Back', 'start')],
            ]),
          },
        );
        return;
      }

      let message = '📚 <b>Your Recent Conversations</b>\n\n';
      conversations.slice(0, 10).forEach((conv, index: number) => {
        const title = conv.title || 'Untitled';
        const date = new Date(conv.updatedAt || conv.createdAt || Date.now()).toLocaleDateString();
        const current = conv.conversationId === botUser.conversationId ? '▶️ ' : '  ';
        message += `${current}<b>${index + 1}.</b> ${title}\n   <i>${date}</i>\n\n`;
      });

      if (conversations.length > 10) {
        message += `\n<i>... and ${conversations.length - 10} more conversations</i>`;
      }

      await ctx.reply(message, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🆕 New Chat', 'new')],
          [Markup.button.callback('« Back', 'start')],
        ]),
      });
    } catch (error) {
      console.error('[Telegram Bot] Error fetching history:', error);
      await ctx.reply('❌ Unable to fetch conversation history.');
    }
  } catch (error) {
    console.error('[Telegram Bot] History error:', error);
    await ctx.reply('Sorry, an error occurred. Please try again later.');
  }
}
