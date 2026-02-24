import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { connectDB } from './lib/db.js';
import { log } from './lib/logger.js';
import { isAbortError, isFatalError, isTransientNetworkError } from './lib/error-classification.js';

// Routes
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import conversationsRouter from './routes/conversations.js';
import foldersRouter from './routes/folders.js';
import chatRouter from './routes/chat.js';
import memoryRouter from './routes/memory.js';
import creditsRouter from './routes/credits.js';
import v1Router from './routes/v1.js';
import accountsRouter from './routes/accounts.js';
import botsRouter from './routes/bots.js';
import mcpRouter from './routes/mcp.js';
import integrationsOauthRouter from './routes/integrations-oauth.js';
import toolsProxyRouter from './routes/tools-proxy.js';
import developerRouter from './routes/developer.js';
import billingRouter from './routes/billing.js';
import organizationRouter from './routes/organization.js';
import canvasRouter from './routes/canvas/index.js';
import feedbackRouter from './routes/feedback.js';
import codeaRouter from './routes/codea.js';
import modelsStatsRouter from './routes/models-stats.js';
import externalModelsRouter from './routes/external-models.js';
import internalRouter from './routes/internal.js';
import skillsRouter from './routes/skills.js';
import automationsRouter from './routes/automations.js';
import analyticsRouter from './routes/analytics.js';
import webhooksRouter from './routes/webhooks.js';
import referralsRouter from './routes/referrals.js';
import agentsRouter from './routes/agents.js';
import agentsAvatarRouter from './routes/agents-avatar.js';
import agentTeamsRouter from './routes/agent-teams.js';
import containersRouter from './routes/containers.js';
import libraryRouter from './routes/library.js';
import suggestionsRouter from './routes/suggestions.js';
import writingStyleRouter from './routes/writing-style.js';

// Register hooks (side-effect import)
import './lib/hooks/index.js';
import { oxyClient } from './middleware/auth.js';
import { resolveWorkspace } from './middleware/workspace.js';
import { syncZeroEval } from './scripts/sync-zeroeval.js';
import { seedSkills } from './lib/seed-skills.js';
import { seedSuggestions } from './lib/seed-suggestions.js';
import { seedBots } from './lib/seed-bots.js';
import { startScheduler } from './lib/automation-scheduler.js';
import { warmupProviders } from './lib/provider-warmup.js';
import { warmupProvidersClient } from './lib/providers-client.js';
import { initChannels } from './lib/channels/index.js';
// Socket.io
import { initSocket } from './socket.js';
// MCP relay for local MCP tool calls via WebSocket
import { initMcpRelay, shutdownMcpRelay } from './lib/mcp-relay.js';

// Fix for ES Modules __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from the api directory (not the monorepo root)
dotenv.config({ path: join(__dirname, '../.env') });

// Initialize multi-channel gateway
initChannels();

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Create HTTP server with optimized settings for streaming
const server = http.createServer({
  // Increase max header size for long authentication tokens
  maxHeaderSize: 16384,
  // Keep connections alive for SSE
  keepAlive: true,
  keepAliveTimeout: 65000, // Slightly higher than default
}, app);

// Handle HTTP server errors (e.g. EADDRINUSE)
server.on('error', (error: NodeJS.ErrnoException) => {
  log.general.error({ err: error }, '[Server] HTTP server error');
  if (error.code === 'EADDRINUSE') {
    log.general.error({ port: PORT }, 'Port already in use');
    process.exit(1);
  }
});

// Optimize server for SSE streaming
server.on('connection', (socket) => {
  // Disable Nagle's algorithm for all connections to reduce latency
  socket.setNoDelay(true);
  // Set keep-alive
  socket.setKeepAlive(true, 60000);
});

initSocket(server);
initMcpRelay(server);

// Note: WebSocket upgrade for providers admin is now handled by alia-providers-api

// Public API routes (/v1) - allow all origins (like OpenAI's API)
app.use('/v1', cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'X-Service-Name', 'X-Timestamp', 'X-Signature', 'X-Session-Id', 'X-Device-Info'],
  optionsSuccessStatus: 200
}));

// Disable nginx/proxy buffering for /v1 SSE streaming responses
app.use('/v1', (_req, res, next) => {
  res.setHeader('X-Accel-Buffering', 'no');
  next();
});

// Internal routes - restricted to known origins
const PRODUCTION_ORIGINS = [
  'https://alia.onl',
  'https://console.alia.onl',
  'https://providers.alia.onl',
];

const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8081',
  'exp://localhost:8081',
  'http://10.0.2.2:8081',
];

const allowedOrigins = [
  ...(process.env.WEB_URL ? [process.env.WEB_URL] : []),
  ...PRODUCTION_ORIGINS,
  ...DEV_ORIGINS,
];

// Internal routes CORS - skip /v1 routes (they have their own permissive CORS above)
app.use((req, res, next) => {
  if (req.path.startsWith('/v1')) return next();
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'X-Service-Name', 'X-Timestamp', 'X-Signature', 'X-Session-Id', 'X-Device-Info', 'X-Oxy-User-Id', 'X-Workspace-Id'],
    optionsSuccessStatus: 200,
  })(req, res, next);
});

// Allow cross-origin resource loading (fixes ERR_BLOCKED_BY_RESPONSE.NotSameOrigin)
app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

// Stripe webhook needs raw body for signature verification
app.use('/billing/webhook', express.raw({ type: 'application/json' }));

// Increase body size limit for large chat contexts
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Optimize SSE routes for real-time streaming
app.use('/alia/chat', (_req, res, next) => {
  // Disable all buffering for SSE
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Disable Nagle's algorithm for lower latency
  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setTimeout(0); // No timeout for SSE connections
  }

  next();
});

// Routes
app.use('/health', healthRouter);
app.use('/auth', authRouter);
app.use('/conversations', conversationsRouter);
app.use('/folders', foldersRouter);
app.use('/memory', memoryRouter);
app.use('/credits', creditsRouter);
app.use('/alia/chat', chatRouter);
app.use('/v1', v1Router);
app.use('/accounts', accountsRouter);
app.use('/bots', botsRouter);
app.use('/mcp', mcpRouter);
app.use('/integrations', integrationsOauthRouter);
app.use('/tools', toolsProxyRouter);
app.use('/developer', resolveWorkspace, developerRouter);
app.use('/billing', billingRouter);
app.use('/organization', organizationRouter);
app.use('/feedback', feedbackRouter);
app.use('/api', canvasRouter);
app.use('/codea', codeaRouter);
app.use('/models', modelsStatsRouter);
app.use('/external-models', externalModelsRouter);
app.use('/skills', skillsRouter);
app.use('/automations', automationsRouter);
app.use('/analytics', analyticsRouter);
app.use('/webhooks', webhooksRouter);
app.use('/referrals', referralsRouter);
app.use('/agents/avatar', agentsAvatarRouter);
app.use('/agents/teams', agentTeamsRouter);
app.use('/agents', agentsRouter);
app.use('/containers', containersRouter);
app.use('/library', libraryRouter);
app.use('/suggestions', suggestionsRouter);
app.use('/writing-style', writingStyleRouter);
app.use('/internal', internalRouter);

// Root route
app.get('/', (_req, res) => {
  res.json({
    message: 'Alia API',
    version: '1.0.0',
    endpoints: [
      '/health',
      '/auth',
      '/conversations',
      '/folders',
      '/memory',
      '/credits',
      '/alia/chat',
      '/v1',
      '/accounts',
      '/bots',
      '/mcp',
      '/integrations',
      '/tools',
      '/developer',
      '/billing',
      '/organization',
      '/feedback',
      '/codea',
      '/models',
      '/external-models',
      '/skills',
      '/automations',
      '/analytics',
      '/webhooks',
      '/agents',
      '/containers',
      '/suggestions',
      '/writing-style',
      '/v1/voice/token',
      '/v1/voice/transcribe',
      '/v1/audio/speech',
      '/internal/trigger'
    ]
  });
});

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.general.error({ err }, 'Unhandled Express error');
  if (!res.headersSent) {
    res.status(500).json({ error: 'Something went wrong!' });
  }
});

// Process-level error handlers — prevent crashes from taking down all users
// Classifies errors to determine logging level (inspired by openclaw)
process.on('unhandledRejection', (reason) => {
  // AbortError: intentional cancellation (user stopped request) — suppress
  if (isAbortError(reason)) return;

  // Fatal: OOM, worker failures — must exit
  if (isFatalError(reason)) {
    log.general.error({ err: reason }, '[Process] FATAL unhandled rejection — shutting down');
    setTimeout(() => process.exit(1), 5000).unref();
    return;
  }

  // Transient network: ECONNRESET, ETIMEDOUT, etc. — expected with external providers
  if (isTransientNetworkError(reason)) {
    log.general.warn({ err: reason }, '[Process] Transient network error (continuing)');
    return;
  }

  // Everything else: log as error but keep running
  log.general.error({ reason: reason instanceof Error ? reason : String(reason) }, '[Process] Unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  log.general.error({ err: error }, '[Process] Uncaught exception — shutting down');
  setTimeout(() => process.exit(1), 5000).unref();
});

// Connect to MongoDB before starting the server
connectDB()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 API Server running on http://0.0.0.0:${PORT}`);
      // Warm up providers client cache (non-blocking)
      warmupProvidersClient().catch((err) => console.error('[Providers] Client warmup error:', err));
      // Seed built-in skills and suggestions (non-blocking)
      seedSkills().catch((err) => console.error('[Skills] Seed error:', err));
      seedSuggestions().catch((err) => console.error('[Suggestions] Seed error:', err));
      seedBots().catch((err) => console.error('[Bots] Seed error:', err));
      // Sync external models in background (non-blocking)
      syncZeroEval().catch((err) => console.error('[ZeroEval] Background sync error:', err));
      // Start automation scheduler (non-blocking)
      startScheduler().catch((err) => console.error('[Scheduler] Startup error:', err));
      // Pre-warm TLS connections to AI providers (non-blocking)
      warmupProviders().catch((err) => console.error('[Warmup] Provider warmup error:', err));
    });

    // Graceful shutdown handler
    const shutdown = async (signal: string) => {
      console.log(`\n[Shutdown] Received ${signal}. Starting graceful shutdown...`);

      // Stop accepting new connections
      server.close(() => {
        console.log('[Shutdown] HTTP server closed (no new connections)');
      });

      // Give in-flight requests 10 seconds to complete
      const forceTimeout = setTimeout(() => {
        console.error('[Shutdown] Force exit after 10s grace period');
        process.exit(1);
      }, 10000);
      forceTimeout.unref(); // Don't keep the process alive for this timer

      try {
        // Close MCP relay connections
        shutdownMcpRelay();

        // Close MongoDB connection
        const mongoose = await import('mongoose');
        await mongoose.default.connection.close();
        log.general.info('MongoDB connection closed');

        clearTimeout(forceTimeout);
        console.log('[Shutdown] Graceful shutdown complete');
        process.exit(0);
      } catch (error) {
        console.error('[Shutdown] Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch((error) => {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  });
