import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import { Server as WebSocketServer } from 'ws';
import http from 'http';
import type { MessagingAdapter } from './messaging/types';

const PORT = process.env.PORT || 3005;
const MONGODB_URI = process.env.MONGODB_URI;
const APP_NAME = 'integrations';

if (!MONGODB_URI) {
  console.error('MONGODB_URI is required');
  process.exit(1);
}

if (!process.env.INTEGRATIONS_SECRET) {
  console.error('INTEGRATIONS_SECRET is required');
  process.exit(1);
}

const adapters: MessagingAdapter[] = [];

async function loadAdapters(): Promise<void> {
  // WhatsApp Gateway
  if (process.env.WHATSAPP_ENABLED !== 'false') {
    const { WhatsAppAdapter } = await import('./messaging/whatsapp/adapter');
    adapters.push(new WhatsAppAdapter());
  }

  // Telegram Gateway
  if (process.env.TELEGRAM_GATEWAY_ENABLED !== 'false') {
    if (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH) {
      console.warn('[Integrations] Telegram Gateway disabled: TELEGRAM_API_ID / TELEGRAM_API_HASH not set');
    } else {
      const { TelegramGatewayAdapter } = await import('./messaging/telegram-gateway/adapter');
      adapters.push(new TelegramGatewayAdapter());
    }
  }

  // Signal Gateway
  if (process.env.SIGNAL_ENABLED !== 'false') {
    const { SignalAdapter } = await import('./messaging/signal/adapter');
    adapters.push(new SignalAdapter());
  }

  // Telegram Bot
  if (process.env.TELEGRAM_BOT_ENABLED !== 'false' && process.env.TELEGRAM_BOT_TOKEN) {
    const { TelegramBotAdapter } = await import('./messaging/telegram-bot/adapter');
    adapters.push(new TelegramBotAdapter());
  }

  // Discord Bot
  if (process.env.DISCORD_BOT_ENABLED !== 'false' && process.env.DISCORD_BOT_TOKEN) {
    const { DiscordBotAdapter } = await import('./messaging/discord-bot/adapter');
    adapters.push(new DiscordBotAdapter());
  }
}

async function main() {
  // Connect to MongoDB
  const dbName = `${APP_NAME}-${process.env.NODE_ENV || 'development'}`;
  await mongoose.connect(MONGODB_URI!, { dbName });
  console.log(`[Integrations] Connected to MongoDB (${dbName})`);

  // Load and initialize adapters
  await loadAdapters();
  for (const adapter of adapters) {
    try {
      await adapter.initialize();
      console.log(`[Integrations] ${adapter.name} adapter initialized`);
    } catch (err) {
      console.error(`[Integrations] Failed to initialize ${adapter.name}:`, err);
    }
  }

  // Express app
  const app = express();
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: APP_NAME,
      uptime: process.uptime(),
      adapters: adapters.map((a) => a.name),
    });
  });

  // Auth middleware for gateway routes
  const requireSecret = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const secret = req.headers['x-gateway-secret'] as string;
    if (secret !== process.env.INTEGRATIONS_SECRET) {
      res.status(401).json({ error: 'Invalid gateway secret' });
      return;
    }
    next();
  };

  // Mount adapter routes
  for (const adapter of adapters) {
    if (adapter.getRouter) {
      app.use(`/${adapter.name}`, requireSecret, adapter.getRouter());
      console.log(`[Integrations] Mounted routes: /${adapter.name}`);
    }
  }

  // Browser routes (lazy-loaded)
  try {
    const { browserRouter } = await import('./routes/browser');
    app.use('/browser', requireSecret, browserRouter);
    console.log('[Integrations] Mounted routes: /browser');
  } catch {
    console.log('[Integrations] Browser routes not available');
  }

  // Terminal routes (lazy-loaded)
  try {
    const { terminalRouter } = await import('./routes/terminal');
    app.use('/terminal', requireSecret, terminalRouter);
    console.log('[Integrations] Mounted routes: /terminal');
  } catch {
    console.log('[Integrations] Terminal routes not available');
  }

  // HTTP + WebSocket server
  const server = http.createServer(app);

  // WebSocket for real-time streaming (terminal output, browser screenshots)
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Handle subscribe/unsubscribe to session streams
        if (msg.type === 'subscribe') {
          (ws as any).sessionId = msg.sessionId;
        }
      } catch {}
    });
  });

  // Make WSS available for terminal/browser managers
  (global as any).__wss = wss;

  server.listen(PORT, () => {
    console.log(`[Integrations] Running on port ${PORT}`);
  });
}

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`[Integrations] Received ${signal}, shutting down...`);
  try {
    for (const adapter of adapters) {
      await adapter.shutdown();
      console.log(`[Integrations] ${adapter.name} shut down`);
    }
    await mongoose.disconnect();
    console.log('[Integrations] MongoDB disconnected');
  } catch (err) {
    console.error('[Integrations] Error during shutdown:', err);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  console.error('[Integrations] Fatal error:', err);
  process.exit(1);
});
