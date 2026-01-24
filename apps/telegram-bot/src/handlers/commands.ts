import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { apiClient } from '../services/api-client';

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

    const currentModel = telegramUser.preferredModel || 'alia-lite';

    const modelInfo = {
      'alia-lite': {
        name: 'Alia Lite',
        description: 'Fast responses (0.5x credits)',
        emoji: '⚡'
      },
      'alia-v1': {
        name: 'Alia V1',
        description: 'Balanced quality (1x credits)',
        emoji: '🎯'
      },
      'alia-v1-codea': {
        name: 'Alia V1 Codea',
        description: 'Optimized for code (1.5x credits)',
        emoji: '💻'
      },
      'alia-v1-pro': {
        name: 'Alia V1 Pro',
        description: 'High quality (3x credits)',
        emoji: '⭐'
      },
      'alia-v1-pro-max': {
        name: 'Alia V1 Pro Max',
        description: 'Best quality (5x credits)',
        emoji: '🚀'
      }
    };

    let message = '🤖 <b>Choose AI Model</b>\n\n';
    message += `<b>Current Model:</b> ${modelInfo[currentModel as keyof typeof modelInfo].emoji} ${modelInfo[currentModel as keyof typeof modelInfo].name}\n\n`;
    message += '<b>Available Models:</b>\n';

    for (const [modelId, info] of Object.entries(modelInfo)) {
      const current = modelId === currentModel ? ' ✓' : '';
      message += `\n${info.emoji} <b>${info.name}</b>${current}\n`;
      message += `   <i>${info.description}</i>`;
    }

    await ctx.reply(message, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('⚡ Lite', 'model_alia-lite'),
          Markup.button.callback('🎯 V1', 'model_alia-v1')
        ],
        [
          Markup.button.callback('💻 Codea', 'model_alia-v1-codea'),
          Markup.button.callback('⭐ Pro', 'model_alia-v1-pro')
        ],
        [
          Markup.button.callback('🚀 Pro Max', 'model_alia-v1-pro-max')
        ],
        [Markup.button.callback('« Back', 'start')]
      ])
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
    // Update the model
    await apiClient.updateTelegramModel(telegramId, modelId);

    const modelInfo: Record<string, { name: string; emoji: string }> = {
      'alia-lite': { name: 'Alia Lite', emoji: '⚡' },
      'alia-v1': { name: 'Alia V1', emoji: '🎯' },
      'alia-v1-codea': { name: 'Alia V1 Codea', emoji: '💻' },
      'alia-v1-pro': { name: 'Alia V1 Pro', emoji: '⭐' },
      'alia-v1-pro-max': { name: 'Alia V1 Pro Max', emoji: '🚀' }
    };

    const info = modelInfo[modelId];

    await ctx.answerCbQuery(`Model changed to ${info.name}`);
    await ctx.reply(
      `${info.emoji} <b>Model Updated</b>\n\n` +
      `Your AI model has been changed to <b>${info.name}</b>.\n\n` +
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
