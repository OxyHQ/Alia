import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { connectToDatabase } from './services/db';
import { handleStart, handleLogin, handleLogout, handleStatus } from './handlers/auth';
import { handleMessage, handleNewConversation, handleHistory } from './handlers/chat';
import { handleHelp } from './handlers/commands';

// Validate environment variables
const requiredEnvVars = ['TELEGRAM_BOT_TOKEN', 'MONGODB_URI'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

// Connect to database
async function initializeBot() {
  try {
    await connectToDatabase();
    console.log('Database connected successfully');

    // Register command handlers
    bot.command('start', handleStart);
    bot.command('login', handleLogin);
    bot.command('logout', handleLogout);
    bot.command('status', handleStatus);
    bot.command('help', handleHelp);
    bot.command('new', handleNewConversation);
    bot.command('history', handleHistory);

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
