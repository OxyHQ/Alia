import 'dotenv/config';
import { startPlatformActivity } from './platform-activity';
import express from 'express';
import { oxyTrustProxy } from '@oxy.so/core/server';
import { Server as WebSocketServer } from 'ws';
import http from 'http';
import { closePostgres, connectPostgres } from './db';
import type { AccountAdapter } from './accounts/types';
import type { BotAdapter } from './bots/types';
import { setWss, type SessionWebSocket } from './realtime/wss-global';
import { maySubscribe } from './realtime/subscription-auth';
import {
  requireAliaApi,
  requireAccountContext,
  internalAccount,
  authorizeInternalUpgrade,
} from './shared/internal-auth';
import { createLogger } from './shared/logger';
import { runShutdownSteps } from './shared/shutdown';

const logger = createLogger('Integrations');

const PORT = Number(process.env.PORT) || 3005;
const INTERNAL_PORT = 3005; // Must match the ECS container health-check port.
const DATABASE_URL = process.env.DATABASE_URL;
const APP_NAME = 'integrations';

if (!DATABASE_URL) {
  logger.error('DATABASE_URL is required');
  process.exit(1);
}
const POSTGRES_URL: string = DATABASE_URL;

let activityReady = false;
const activity = startPlatformActivity(() => activityReady);
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
      logger.warn('Telegram Gateway disabled: valid TELEGRAM_API_ID / TELEGRAM_API_HASH not set');
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

  // Gmail
  if (process.env.GMAIL_ENABLED !== 'false') {
    const { GmailAdapter } = await import('./accounts/gmail/adapter');
    accountAdapters.push(new GmailAdapter());
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

async function initAdapterWithTimeout(adapter: {
  name: string;
  initialize(): Promise<void>;
}): Promise<void> {
  await Promise.race([
    adapter.initialize(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out after ${ADAPTER_INIT_TIMEOUT_MS / 1000}s`)),
        ADAPTER_INIT_TIMEOUT_MS,
      ),
    ),
  ]);
}

async function main() {
  // Build the pool before an adapter can query it. A MALFORMED DATABASE_URL
  // throws here and takes the boot down; an unreachable server does not —
  // postgres.js opens a socket lazily, so that surfaces on the first query.
  connectPostgres(POSTGRES_URL);
  logger.info('Postgres pool ready');

  // Load adapter instances (constructors only — no external calls)
  await loadAdapters();

  // Express app
  const app = express();
  // The real client behind the ALB (and Cloudflare, when proxied); see
  // `oxyTrustProxy` in @oxy.so/core.
  app.set('trust proxy', oxyTrustProxy);
  if (activity) app.use(activity.observeHttp);
  app.use(express.json());

  // Health check
  app.get('/health', async (_req, res) => {
    let mcpSessions: import('./mcp/manager').McpSessionSummary[] = [];
    try {
      const { listSessions } = await import('./mcp/manager');
      mcpSessions = listSessions();
    } catch (err) {
      // MCP session summary is best-effort — a health check must still respond.
      logger.debug('Failed to list MCP sessions for health check:', err);
    }

    res.json({
      status: 'ok',
      service: APP_NAME,
      uptime: process.uptime(),
      accounts: accountAdapters.map((a) => a.name),
      bots: botAdapters.map((a) => a.name),
      mcpServers: mcpSessions.length,
    });
  });

  /** Scope terminal/browser resources to the verified API operation account. */
  const requireSessionOwner = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void => {
    const ownerUserId = internalAccount(req);
    if (!ownerUserId) {
      res.status(401).json({ error: 'User context required' });
      return;
    }
    // Inside the mounted router, req.path is `/session/<sessionId>/<action>`.
    const match = req.path.match(/^\/session\/([^/]+)\//);
    const sessionId = match ? decodeURIComponent(match[1]) : '';
    if (!sessionId.startsWith(`${ownerUserId}:`)) {
      res.status(403).json({ error: 'Session does not belong to user' });
      return;
    }
    next();
  };

  // Mount account adapter routes under /accounts/<platform>
  for (const adapter of accountAdapters) {
    app.use(
      `/accounts/${adapter.name}`,
      requireAliaApi,
      requireAccountContext,
      adapter.getRouter(),
    );
    logger.info(`Mounted account routes: /accounts/${adapter.name}`);
  }

  // Bot adapters don't expose REST routes (they use polling/websockets)

  // MCP server management routes
  const { mcpRouter } = await import('./mcp/routes');
  app.use('/mcp', requireAliaApi, requireAccountContext, mcpRouter);
  logger.info('Mounted routes: /mcp');

  // Browser routes (lazy-loaded)
  try {
    const { browserRouter } = await import('./routes/browser');
    app.use('/browser', requireAliaApi, requireAccountContext, requireSessionOwner, browserRouter);
    logger.info('Mounted routes: /browser');
  } catch (err) {
    logger.info('Browser routes not available');
    logger.debug('Browser route load error:', err);
  }

  // Terminal routes (lazy-loaded)
  try {
    const { terminalRouter } = await import('./routes/terminal');
    app.use(
      '/terminal',
      requireAliaApi,
      requireAccountContext,
      requireSessionOwner,
      terminalRouter,
    );
    logger.info('Mounted routes: /terminal');
  } catch (err) {
    logger.info('Terminal routes not available');
    logger.debug('Terminal route load error:', err);
  }

  // HTTP + WebSocket server
  const server = http.createServer(app);

  // WebSocket for real-time streaming (terminal output, browser screenshots)
  const wss = new WebSocketServer({ server, path: '/ws' });
  // The upgrade verifies the same workload and account context as HTTP.
  wss.on('connection', async (ws, request) => {
    const ownerUserId = await authorizeInternalUpgrade(request.headers);
    if (!ownerUserId) {
      logger.debug('Rejected an unauthenticated internal WebSocket upgrade');
      // 1008 is "policy violation" — the honest code, and it reaches the client
      // as a close reason rather than as a connection that silently never
      // receives anything.
      ws.close(1008, 'Internal authentication required');
      return;
    }

    activity?.observeWebSocket(ws, {
      activityType: 'communication',
      getPeer: () => ({
        service: 'alia',
        region:
          typeof request.headers['x-oxy-source-region'] === 'string'
            ? request.headers['x-oxy-source-region']
            : undefined,
      }),
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Handle subscribe/unsubscribe to session streams
        if (msg.type === 'subscribe') {
          if (!maySubscribe(ownerUserId, msg.sessionId)) {
            logger.debug('Refused a subscription outside the connection owner namespace');
            return;
          }
          (ws as SessionWebSocket).sessionId = msg.sessionId;
        }
      } catch (err) {
        // Malformed client frame — ignore it rather than tearing down the socket.
        logger.debug('Discarded malformed WebSocket message:', err);
      }
    });
  });

  // Make WSS available for terminal/browser managers
  setWss(wss);

  // Start HTTP server FIRST so health checks pass during adapter initialization
  await new Promise<void>((resolve) => {
    server.listen(PORT, () => {
      activityReady = true;
      logger.info(`Running on port ${PORT}`);
      resolve();
    });
  });

  // If an operator overrides PORT, retain the canonical internal health port so
  // the ECS container health check remains reachable.
  if (PORT !== INTERNAL_PORT) {
    const healthServer = http.createServer(app);
    healthServer.listen(INTERNAL_PORT, () => {
      logger.info(`Health/internal on port ${INTERNAL_PORT}`);
    });
  }

  // Initialize all adapters AFTER the server is listening (with timeouts)
  const allAdapters = [...accountAdapters, ...botAdapters];
  for (const adapter of allAdapters) {
    try {
      await initAdapterWithTimeout(adapter);
      logger.info(`${adapter.name} adapter initialized`);
    } catch (err) {
      logger.error(`Failed to initialize ${adapter.name}:`, err);
    }
  }
}

// Graceful shutdown
async function shutdown(signal: string) {
  activityReady = false;
  logger.info(`Received ${signal}, shutting down...`);
  const allAdapters = [...accountAdapters, ...botAdapters];
  const failed = await runShutdownSteps(
    [
      {
        name: 'MCP servers',
        run: async () => {
          const { shutdownAll: shutdownMcp } = await import('./mcp/manager');
          await shutdownMcp();
        },
      },
      ...allAdapters.map((adapter) => ({ name: adapter.name, run: () => adapter.shutdown() })),
      { name: 'platform activity', run: async () => activity?.stop() },
      { name: 'Postgres pool', run: () => closePostgres() },
    ],
    logger,
  );
  if (failed.length > 0) {
    logger.error(`Shutdown finished with failures in: ${failed.join(', ')}`);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
