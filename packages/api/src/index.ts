import express from 'express';
import http from 'http';
import cors from 'cors';
import { createOxyCors } from '@oxyhq/core/server';
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
// folders route removed — was unimplemented (501 stubs)
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
import analyticsRouter from './routes/analytics.js';
import webhooksRouter from './routes/webhooks.js';
import referralsRouter from './routes/referrals.js';
import triggersRouter from './routes/triggers.js';
import agentsRouter from './routes/agents.js';
import agentsAvatarRouter from './routes/agents-avatar.js';
import agentTeamsRouter from './routes/agent-teams.js';
import containersRouter from './routes/containers.js';
import libraryRouter from './routes/library.js';
import suggestionsRouter from './routes/suggestions.js';
import writingStyleRouter from './routes/writing-style.js';
import notificationsRouter from './routes/notifications.js';
import auditRouter from './routes/audit.js';
import oxyServiceEventsRouter from './routes/oxy-service-events.js';

// Register hooks (side-effect import)
import './lib/hooks/index.js';
import { authenticateToken } from './middleware/auth.js';
import { resolveWorkspace } from './middleware/workspace.js';
import { syncZeroEval } from './scripts/sync-zeroeval.js';
import { seedSkills } from './lib/seed-skills.js';
import { seedSuggestions } from './lib/seed-suggestions.js';
import { seedBots } from './lib/seed-bots.js';
import { startTriggerEngine, stopTriggerEngine } from './lib/trigger-engine.js';
import { warmupProviders } from './lib/provider-warmup.js';
import { warmupGatewayClient } from './lib/gateway-client.js';
import { runPendingMigrations } from './lib/migrations/runner.js';
import { initChannels } from './lib/channels/index.js';
// Socket.io
import { initSocket } from './socket.js';
// MCP relay for local MCP tool calls via WebSocket
import { initMcpRelay, shutdownMcpRelay } from './lib/mcp-relay.js';
// Task queue for async agent sessions (BullMQ + Redis)
import { initTaskQueue, startWorker, shutdownTaskQueue } from './lib/task-queue.js';
import { initShowQueue, startShowWorker, shutdownShowQueue } from './lib/show/show-queue.js';

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

// Note: WebSocket upgrade for gateway admin is now handled by alia-gateway

// Public API routes (/v1) - allow all origins (like OpenAI's API)
app.use('/v1', cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
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
  'https://gateway.alia.onl',
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

// Internal routes CORS via the shared Oxy allowlist (constant-time match, no
// origin reflection, never a wildcard-with-credentials). Requests with no Origin
// header (mobile apps, curl, server-to-server) pass through untouched — matching
// the previous hand-rolled behavior. /v1 keeps its own permissive public CORS above.
const internalCors = createOxyCors({
  appOrigins: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'X-Service-Name', 'X-Timestamp', 'X-Signature', 'X-Session-Id', 'X-Device-Info', 'X-Oxy-User-Id', 'X-Workspace-Id'],
});
app.use((req, res, next) => {
  if (req.path.startsWith('/v1')) return next();
  internalCors(req, res, next);
});

// Allow cross-origin resource loading (fixes ERR_BLOCKED_BY_RESPONSE.NotSameOrigin)
app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

// Stripe webhook needs raw body for signature verification
app.use('/billing/webhook', express.raw({ type: 'application/json' }));

// Increase body size limit for large chat contexts. Capture the raw body so the
// service-to-service HMAC (providers middleware) can bind a body hash.
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    (req as express.Request).rawBody = buf;
  },
}));
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

app.use('/memory', memoryRouter);
app.use('/credits', creditsRouter);
app.use('/alia/chat', chatRouter);
app.use('/v1', v1Router);
app.use('/accounts', accountsRouter);
app.use('/bots', botsRouter);
app.use('/mcp', mcpRouter);
app.use('/integrations', integrationsOauthRouter);
app.use('/tools', toolsProxyRouter);
app.use('/developer', authenticateToken, resolveWorkspace, developerRouter);
app.use('/billing', billingRouter);
app.use('/organization', organizationRouter);
app.use('/feedback', feedbackRouter);
app.use('/api', canvasRouter);
app.use('/codea', codeaRouter);
app.use('/models', modelsStatsRouter);
app.use('/external-models', externalModelsRouter);
app.use('/skills', skillsRouter);
app.use('/analytics', analyticsRouter);
app.use('/triggers', triggersRouter);
app.use('/webhooks', webhooksRouter);
app.use('/webhooks/oxy', oxyServiceEventsRouter);
app.use('/referrals', referralsRouter);
app.use('/agents/avatar', agentsAvatarRouter);
app.use('/agents/teams', agentTeamsRouter);
app.use('/agents', agentsRouter);
app.use('/containers', containersRouter);
app.use('/library', libraryRouter);
app.use('/suggestions', suggestionsRouter);
app.use('/writing-style', writingStyleRouter);
app.use('/notifications', notificationsRouter);
app.use('/audit', auditRouter);
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
      '/triggers',
      '/analytics',
      '/webhooks',
      '/agents',
      '/containers',
      '/suggestions',
      '/writing-style',
      '/notifications',
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

// Background services that depend on a live MongoDB connection. Run once the
// first connection is established (and re-seeding is idempotent on reconnect).
let backgroundServicesStarted = false;
function startBackgroundServices(): void {
  if (backgroundServicesStarted) return;
  backgroundServicesStarted = true;

  // Run pending data migrations first — idempotent, safe on every boot.
  runPendingMigrations().catch((err) => log.general.error({ err }, '[Migrations] Runner error'));

  // Warm up gateway client cache (non-blocking)
  warmupGatewayClient().catch((err) => log.general.error({ err }, '[Gateway] Client warmup error'));
  // Seed built-in skills and suggestions (non-blocking)
  seedSkills().catch((err) => log.general.error({ err }, '[Skills] Seed error'));
  seedSuggestions().catch((err) => log.general.error({ err }, '[Suggestions] Seed error'));
  seedBots().catch((err) => log.general.error({ err }, '[Bots] Seed error'));
  // Sync external models in background (non-blocking)
  syncZeroEval().catch((err) => log.general.error({ err }, '[ZeroEval] Background sync error'));
  // Start trigger engine under leader election (non-blocking) — only the
  // elected instance runs the scheduler, so triggers fire once across tasks.
  startTriggerEngine();
  // Initialize task queue for async agent sessions (non-blocking)
  initTaskQueue()
    .then(() => startWorker())
    .catch((err) => log.general.error({ err }, '[TaskQueue] Startup error'));
  // Clean up orphaned audio jobs from previous process crashes (non-blocking)
  import('./models/audio-job.js').then(({ AudioJob }) =>
    AudioJob.cleanupOrphanedJobs()
  ).catch((err) => log.general.error({ err }, '[AudioJob] Orphan cleanup error'));
  // Initialize show generation queue (non-blocking)
  initShowQueue()
    .then(() => startShowWorker())
    .catch((err) => log.general.error({ err }, '[ShowQueue] Startup error'));
}

// Attempt the MongoDB connection in the background with retry. The HTTP server
// starts listening regardless so liveness probes pass and the process stays up
// even when MongoDB/Redis are temporarily unreachable (readiness stays 503
// until the database is connected).
function connectWithRetry(attempt = 1): void {
  connectDB()
    .then(() => {
      log.general.info('MongoDB ready — starting background services');
      startBackgroundServices();
    })
    .catch((error) => {
      const delayMs = Math.min(30_000, 2_000 * attempt);
      log.general.error(
        { err: error, attempt, retryInMs: delayMs },
        'MongoDB connection failed — retrying (server remains up; readiness will report not_ready)'
      );
      setTimeout(() => connectWithRetry(attempt + 1), delayMs).unref();
    });
}

// Start listening immediately — do not block on external dependencies.
server.listen(PORT, '0.0.0.0', () => {
  log.general.info(`🚀 API Server running on http://0.0.0.0:${PORT}`);

  // Kick off MongoDB connection (with retry) and dependent background services.
  connectWithRetry();

  // Pre-warm TLS connections to AI providers (non-blocking, no DB dependency)
  warmupProviders().catch((err) => log.general.error({ err }, '[Warmup] Provider warmup error'));

  // Verify Redis connectivity (non-blocking)
  import('./lib/redis.js').then(({ getRedisClient }) => {
    const redis = getRedisClient();
    if (redis) {
      redis.ping()
        .then(() => log.general.info('Redis readiness check passed'))
        .catch((err) => log.general.warn({ err }, 'Redis readiness check failed — rate limiting will fail-open'));
    } else {
      log.general.info('Redis not configured (REDIS_URL not set) — rate limiting disabled');
    }
  }).catch((err) => log.general.warn({ err }, 'Redis readiness check init failed'));
});

// Graceful shutdown handler
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.general.info(`Received ${signal}. Starting graceful shutdown...`);

  // Stop accepting new connections
  server.close(() => {
    log.general.info('HTTP server closed (no new connections)');
  });

  // Give in-flight requests 30 seconds to complete (agent sessions can be long)
  const forceTimeout = setTimeout(() => {
    log.general.error('Force exit after 30s grace period');
    process.exit(1);
  }, 30_000);
  forceTimeout.unref();

  try {
    // Close Socket.IO connections
    const { getIO } = await import('./socket.js');
    const io = getIO();
    if (io) {
      await new Promise<void>((resolve) => io.close(() => resolve()));
      log.general.info('Socket.IO closed');
    }

    // Release the trigger-engine leadership lease and stop scheduled tasks
    await stopTriggerEngine();
    log.general.info('Trigger engine stopped');

    // Close task queue (drains in-flight jobs)
    await shutdownTaskQueue();
    await shutdownShowQueue();
    log.general.info('Task queues shut down');

    // Close Redis connections
    const { closeRedis } = await import('./lib/redis.js');
    await closeRedis();
    log.general.info('Redis connections closed');

    // Close MCP relay connections
    shutdownMcpRelay();

    // Close MongoDB connection
    const mongoose = await import('mongoose');
    await mongoose.default.connection.close();
    log.general.info('MongoDB connection closed');

    clearTimeout(forceTimeout);
    log.general.info('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    log.general.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
