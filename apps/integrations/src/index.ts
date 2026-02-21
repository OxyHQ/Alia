import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import { Server as WebSocketServer } from 'ws';
import http from 'http';
import type { AccountAdapter } from './accounts/types';
import type { BotAdapter } from './bots/types';

const PORT = Number(process.env.PORT) || 3005;
const INTERNAL_PORT = 3005; // Must match DO App Platform internal_ports + health_check.port
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

const accountAdapters: AccountAdapter[] = [];
const botAdapters: BotAdapter[] = [];

async function loadAdapters(): Promise<void> {
  // Account Adapters — personal user accounts (passive monitoring + response)

  // WhatsApp
  if (process.env.WHATSAPP_ENABLED !== 'false') {
    const { WhatsAppAdapter } = await import('./accounts/whatsapp/adapter');
    accountAdapters.push(new WhatsAppAdapter());
  }

  // Telegram Gateway
  if (process.env.TELEGRAM_GATEWAY_ENABLED !== 'false') {
    const telegramApiId = Number(process.env.TELEGRAM_API_ID);
    const telegramApiHash = process.env.TELEGRAM_API_HASH;
    if (!telegramApiId || isNaN(telegramApiId) || !telegramApiHash) {
      console.warn('[Integrations] Telegram Gateway disabled: valid TELEGRAM_API_ID / TELEGRAM_API_HASH not set');
    } else {
      const { TelegramGatewayAdapter } = await import('./accounts/telegram-gateway/adapter');
      accountAdapters.push(new TelegramGatewayAdapter());
    }
  }

  // Signal
  if (process.env.SIGNAL_ENABLED !== 'false') {
    const { SignalAdapter } = await import('./accounts/signal/adapter');
    accountAdapters.push(new SignalAdapter());
  }

  // Bot Adapters — system bots (active sending + external user interaction)

  // Telegram Bot
  if (process.env.TELEGRAM_BOT_ENABLED !== 'false' && process.env.TELEGRAM_BOT_TOKEN) {
    const { TelegramBotAdapter } = await import('./bots/telegram-bot/adapter');
    botAdapters.push(new TelegramBotAdapter());
  }

  // Discord Bot
  if (process.env.DISCORD_BOT_ENABLED !== 'false' && process.env.DISCORD_BOT_TOKEN) {
    const { DiscordBotAdapter } = await import('./bots/discord-bot/adapter');
    botAdapters.push(new DiscordBotAdapter());
  }
}

const ADAPTER_INIT_TIMEOUT_MS = 30_000;

async function initAdapterWithTimeout(adapter: { name: string; initialize(): Promise<void> }): Promise<void> {
  await Promise.race([
    adapter.initialize(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ADAPTER_INIT_TIMEOUT_MS / 1000}s`)), ADAPTER_INIT_TIMEOUT_MS),
    ),
  ]);
}

async function main() {
  // Connect to MongoDB
  const dbName = `${APP_NAME}-${process.env.NODE_ENV || 'development'}`;
  await mongoose.connect(MONGODB_URI!, { dbName });
  console.log(`[Integrations] Connected to MongoDB (${dbName})`);

  // Load adapter instances (constructors only — no external calls)
  await loadAdapters();

  // Express app
  const app = express();
  app.use(express.json());

  // Health check
  app.get('/health', async (_req, res) => {
    let mcpSessions: any[] = [];
    try {
      const { listSessions } = await import('./mcp/manager');
      mcpSessions = listSessions();
    } catch {}

    res.json({
      status: 'ok',
      service: APP_NAME,
      uptime: process.uptime(),
      accounts: accountAdapters.map((a) => a.name),
      bots: botAdapters.map((a) => a.name),
      mcpServers: mcpSessions.length,
    });
  });

  // Auth middleware
  const requireSecret = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const secret = req.headers['x-gateway-secret'] as string;
    if (secret !== process.env.INTEGRATIONS_SECRET) {
      res.status(401).json({ error: 'Invalid gateway secret' });
      return;
    }
    next();
  };

  // Mount account adapter routes under /accounts/<platform>
  for (const adapter of accountAdapters) {
    app.use(`/accounts/${adapter.name}`, requireSecret, adapter.getRouter());
    console.log(`[Integrations] Mounted account routes: /accounts/${adapter.name}`);
  }

  // Bot adapters don't expose REST routes (they use polling/websockets)

  // MCP server management routes
  const { mcpRouter } = await import('./mcp/routes');
  app.use('/mcp', requireSecret, mcpRouter);
  console.log('[Integrations] Mounted routes: /mcp');

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

  // Start HTTP server FIRST so health checks pass during adapter initialization
  await new Promise<void>((resolve) => {
    server.listen(PORT, () => {
      console.log(`[Integrations] Running on port ${PORT}`);
      resolve();
    });
  });

  // If DO App Platform overrides PORT (e.g. to 8080 via http_port), also listen
  // on the internal port so health checks and internal_ports routing still work.
  if (PORT !== INTERNAL_PORT) {
    const healthServer = http.createServer(app);
    healthServer.listen(INTERNAL_PORT, () => {
      console.log(`[Integrations] Health/internal on port ${INTERNAL_PORT}`);
    });
  }

  // Initialize all adapters AFTER the server is listening (with timeouts)
  const allAdapters = [...accountAdapters, ...botAdapters];
  for (const adapter of allAdapters) {
    try {
      await initAdapterWithTimeout(adapter);
      console.log(`[Integrations] ${adapter.name} adapter initialized`);
    } catch (err) {
      console.error(`[Integrations] Failed to initialize ${adapter.name}:`, err);
    }
  }
}

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`[Integrations] Received ${signal}, shutting down...`);
  try {
    // Shutdown MCP servers
    const { shutdownAll: shutdownMcp } = await import('./mcp/manager');
    await shutdownMcp();
    console.log('[Integrations] MCP servers shut down');

    const allAdapters = [...accountAdapters, ...botAdapters];
    for (const adapter of allAdapters) {
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
