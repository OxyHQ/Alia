import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { apiClient } from '../services/api-client';

// Cache models from API (refreshed periodically)
let cachedModels: { id: string; name: string; description: string; emoji?: string; category: string; pricing: { credit_multiplier: number } }[] = [];
let lastFetchTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getModels() {
  if (cachedModels.length === 0 || Date.now() - lastFetchTime > CACHE_TTL_MS) {
    cachedModels = await apiClient.fetchModels();
    lastFetchTime = Date.now();
  }
  return cachedModels;
}

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
        Markup.button.callback('📊 My Status', 'status')
      ],
      [Markup.button.url('🌐 Visit Alia App', 'https://alia.onl')]
    ])
  });
}

export async function handleModel(ctx: Context) {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) {
    await ctx.reply('Unable to identify you. Please try again.');
    return;
  }

  try {
    // Get telegram user to check current model
    const telegramUser = await apiClient.getTelegramUser(telegramId);

    if (!telegramUser || !telegramUser.isAuthenticated) {
      await ctx.reply(
        '🔒 <b>Authentication Required</b>\n\n' +
        'Please sign in first to change your AI model.',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔐 Sign In', 'start')]
          ])
        }
      );
      return;
    }

    const models = await getModels();
    if (models.length === 0) {
      await ctx.reply('❌ Unable to fetch available models. Please try again later.');
      return;
    }

    const currentModel = telegramUser.preferredModel || 'alia-lite';

    let message = '🤖 <b>Choose AI Model</b>\n\n';
    const currentInfo = models.find(m => m.id === currentModel);
    message += `<b>Current Model:</b> ${currentInfo?.emoji || '🤖'} ${currentInfo?.name || currentModel}\n\n`;
    message += '<b>Available Models:</b>\n';

    for (const model of models) {
      const current = model.id === currentModel ? ' ✓' : '';
      message += `\n${model.emoji || '🤖'} <b>${model.name}</b>${current}\n`;
      message += `   <i>${model.description} (${model.pricing.credit_multiplier}x credits)</i>`;
    }

    // Build button rows (2 per row)
    const buttonRows: ReturnType<typeof Markup.button.callback>[][] = [];
    let currentRow: ReturnType<typeof Markup.button.callback>[] = [];
    for (const model of models) {
      currentRow.push(Markup.button.callback(
        `${model.emoji || '🤖'} ${model.name}`,
        `model_${model.id}`
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
      ...Markup.inlineKeyboard(buttonRows)
    });
  } catch (error) {
    console.error('Model command error:', error);
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
    await apiClient.updateTelegramModel(telegramId, modelId);

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
          [Markup.button.callback('« Back to Menu', 'start')]
        ])
      }
    );
  } catch (error) {
    console.error('Model selection error:', error);
    await ctx.answerCbQuery('Error updating model');
    await ctx.reply('❌ Error updating model. Please try again.');
  }
}
