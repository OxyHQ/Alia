// Load dotenv only in development (App Platform injects env vars directly)
if (process.env.NODE_ENV !== 'production') {
  try {
    require('dotenv/config');
  } catch (e) {
    // dotenv not available, environment variables should be set by platform
  }
}

import { Telegraf } from 'telegraf';
import { handleStart, handleLogout, handleStatus } from './handlers/auth';
import { handleMessage, handleNewConversation, handleHistory } from './handlers/chat';
import { handleHelp } from './handlers/commands';

// Validate environment variables
const requiredEnvVars = ['TELEGRAM_BOT_TOKEN', 'API_BASE_URL'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

// Initialize bot
async function initializeBot() {
  try {
    console.log('Initializing Telegram bot...');

    // Set bot commands menu
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Link your Alia account' },
      { command: 'status', description: 'View account status and credits' },
      { command: 'new', description: 'Start a new conversation' },
      { command: 'history', description: 'View recent conversations' },
      { command: 'help', description: 'Show help guide' },
      { command: 'logout', description: 'Disconnect your account' }
    ]);

    // Register command handlers
    bot.command('start', handleStart);
    bot.command('logout', handleLogout);
    bot.command('status', handleStatus);
    bot.command('help', handleHelp);
    bot.command('new', handleNewConversation);
    bot.command('history', handleHistory);

    // Register callback query handlers for inline buttons
    bot.action('start', handleStart);
    bot.action('logout', handleLogout);
    bot.action('status', handleStatus);
    bot.action('help', handleHelp);
    bot.action('new', handleNewConversation);
    bot.action('history', handleHistory);

    // Answer all callback queries to remove loading state
    bot.on('callback_query', async (ctx, next) => {
      await ctx.answerCbQuery();
      return next();
    });

    // Handle all text messages (chat with Alia)
    bot.on('text', async (ctx, next) => {
      const text = ctx.message.text;

      // Skip if it's a command
      if (text.startsWith('/')) {
        return next();
      }

      // Handle as chat message
      await handleMessage(ctx);
    });

    // Error handling
    bot.catch((err: any, ctx: any) => {
      console.error('Bot error:', err);
      ctx.reply('An error occurred. Please try again later.');
    });

    // Start the bot
    await bot.launch();
    console.log('Bot started successfully');

    // Enable graceful stop
    process.once('SIGINT', () => {
      console.log('Stopping bot (SIGINT)...');
      bot.stop('SIGINT');
    });
    process.once('SIGTERM', () => {
      console.log('Stopping bot (SIGTERM)...');
      bot.stop('SIGTERM');
    });

    console.log('Alia Telegram Bot is running!');
  } catch (error) {
    console.error('Failed to initialize bot:', error);
    process.exit(1);
  }
}

// Start the bot
initializeBot();
