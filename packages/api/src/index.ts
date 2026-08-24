import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { closePostgres } from './db/index.js';
import { runBootGuards } from './lib/boot-guards.js';
import { createInternalCors } from './lib/cors-origins.js';
import { startExpirySweeper, stopExpirySweeper } from './db/expirySweeper.js';
import { log } from './lib/logger.js';
import { isAbortError, isFatalError, isTransientNetworkError } from './lib/error-classification.js';

// Routes
import healthRouter from './routes/health.js';
import mediaRouter from './routes/media.js';
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
import codeaRouter from './routes/codea.js';
import modelsStatsRouter from './routes/models-stats.js';
import catalogueRouter from './routes/catalogue.js';
import externalModelsRouter from './routes/external-models.js';
import localRuntimesRouter from './routes/local-runtimes.js';
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
import reportsRouter from './routes/reports.js';
import { createCrowdSourceWebhookRoutes } from './routes/crowdsource-webhook.js';

// Register hooks (side-effect import)
import './lib/hooks/index.js';
import { aliasDeprecationHeaders } from './middleware/alias-deprecation.js';
import { credentialDeprecationHeaders } from './middleware/credential-deprecation.js';
import { authenticateToken } from './middleware/auth.js';
import { resolveWorkspace } from './middleware/workspace.js';
import { startBackgroundServices, stopBackgroundServices } from './lib/background-services.js';
import { warmupProviders } from './lib/provider-warmup.js';
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
// Local dev default only — ECS injects PORT explicitly (oxy-infra
// terraform-uswest2/app-services-realtime.tf sets it to 3001) and DigitalOcean
// App Platform injects it from http_port. 4150 is the main API's slot in Alia's
// 4150-4159 block of the per-app port map, so several Oxy backends can run side
// by side on one machine.
const PORT = parseInt(process.env.PORT || '4150', 10);

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

// Public API routes (/v1) - allow all origins (like OpenAI's API)
app.use('/v1', cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'X-Service-Name', 'X-Timestamp', 'X-Signature', 'X-Session-Id', 'X-Device-Info'],
  // A deprecation header a browser client cannot read is not a signal. Without
  // this, `Deprecation`, `Sunset` and `Link` are stripped from every
  // cross-origin response before the SDK ever sees them.
  exposedHeaders: ['Deprecation', 'Sunset', 'Link'],
  optionsSuccessStatus: 200
}));

// Disable nginx/proxy buffering for /v1 SSE streaming responses
app.use('/v1', (_req, res, next) => {
  res.setHeader('X-Accel-Buffering', 'no');
  next();
});

// Internal routes - restricted to known origins.
// The allowlist and the middleware built from it live in `lib/cors-origins.ts`;
// see that module for why, and for what an entry with an opaque origin does.
// Requests with no Origin header (mobile apps, curl, server-to-server) pass
// through untouched. /v1 keeps its own permissive public CORS above.
const internalCors = createInternalCors(process.env.WEB_URL);
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

/**
 * The CrowdSource webhook receiver MUST stay above `express.json()`.
 *
 * Its HMAC covers the exact bytes that arrived, and it reads the request stream
 * itself. Mounting it below the parser would leave it verifying a signature over a
 * re-serialisation — the route refuses outright if that ever happens
 * (`assertRawBody`), and `crowdsource-webhook-mount.test.ts` asserts the refusal,
 * because a mount order is not something a type can hold.
 *
 * This router only answers `POST /crowdsource`; every other `/webhooks/*` path
 * falls through to `webhooksRouter` below, which still gets a parsed body.
 */
app.use('/webhooks', createCrowdSourceWebhookRoutes());

// `rawBody` is declared here because this hook is the only thing that sets it.
// It outlived its original consumer: the declaration used to sit in the
// `/internal/gateway` HMAC middleware, which was never mounted and is now gone.
// The field is still READ, by `@oxyhq/crowdsource-express` — `readRawBody` does
// a `Reflect.get(request, 'rawBody')` before touching the stream, which no grep
// of this repo can see. That is the trap `crowdsource-webhook.ts` guards
// against, so keep both the hook and the guard.
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

// Increase body size limit for large chat contexts.
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    (req as express.Request).rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// The alias deprecation signal (compatibility window (a), RFC 9745 + RFC 8594).
// Below the body parsers because it reads `body.model`, and above every route
// because the subject is the alias, not one surface: `/alia/chat` and `/v1/*`
// both name aliases and both owe their callers the notice.
app.use(aliasDeprecationHeaders);

// The credential deprecation signal (compatibility window (c), same two RFCs).
// Above every route for the same reason: an `alia_sk_*` credential authenticates
// `/v1/*`, `/codea/*` and the MCP relay alike, so the notice cannot belong to one
// mount. It reads only the Authorization header, so the body parsers above it are
// incidental rather than required.
app.use(credentialDeprecationHeaders);

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

/**
 * Serving one stored object: unauthenticated by necessity, authorised by the
 * link.
 *
 * A browser's `<audio src>` sends no `Authorization` header and Alia is
 * cookie-less, so no media element can satisfy the auth middleware — behind it
 * this is a route nothing can play. The query string carries a signed,
 * expiring capability for ONE object instead; `lib/audio-playback-link.ts` says
 * what that trade costs.
 *
 * Mounted HERE and not under `/v1`, though clips are produced by
 * `/v1/audio/speech`. `/v1` is the OpenAI-compatibility surface, frozen by ADR
 * 0004 and sunsetting under ADR 0003 — a route that exists to serve Alia's own
 * player is not part of the API anyone is compatible WITH, and putting it there
 * would grow a surface whose whole point is that it does not grow.
 */
app.use('/media', mediaRouter);
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
app.use('/api', canvasRouter);
app.use('/codea', codeaRouter);
app.use('/models', modelsStatsRouter);
// Outside `/v1` on purpose: ADR 0004 keeps that surface frozen at the routes it
// already has. See routes/catalogue.ts for the full shape argument.
app.use('/catalogue', catalogueRouter);
app.use('/external-models', externalModelsRouter);
app.use('/local-runtimes', localRuntimesRouter);
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
app.use('/reports', reportsRouter);
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
      '/codea',
      '/models',
      '/external-models',
      '/local-runtimes',
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

/*
 * Every refusal that must happen before the socket opens — #139 workstreams 2
 * and 8, plus the Postgres requirement.
 *
 * The bodies live in `lib/boot-guards.ts` rather than here, because nothing
 * imports this file and anything written in it can only be guarded by a
 * source-text census. That proved insufficient: the direct-provider guard was
 * measurably able to lose its `process.exit` while every suite in the repo
 * stayed green. `lib/__tests__/boot-guards.test.ts` now asserts the refusals,
 * their ORDER, and that each one terminates.
 *
 * What only `db/__tests__/bootWiring.test.ts` can still see is that this call
 * exists, precedes `listen`, and hands over the REAL `process.exit` — a call
 * site passing a no-op would satisfy every behavioural test.
 */
runBootGuards({
  reportFatal: (message, detail) => {
    if (detail === undefined) log.general.error(message);
    else log.general.error(detail, message);
  },
  reportInfo: (message) => log.general.info(message),
  exit: (code) => process.exit(code),
});

// Start listening immediately — do not block on external dependencies.
server.listen(PORT, '0.0.0.0', () => {
  log.general.info(`🚀 API Server running on http://0.0.0.0:${PORT}`);

  /**
   * Delete rows whose expiry has passed. This replaces 14 Mongo TTL indexes and
   * had NO caller when it was written — the targets were registered and tested,
   * and nothing ever swept them, so every expiry in the Postgres schema was
   * inert.
   */
  startExpirySweeper();

  /**
   * The trigger engine, the moderation-outbox dispatcher, both queues and the
   * container pool.
   *
   * These were gated on `connectDB()` resolving, which after the Mongo
   * decommission it never does, so none of them had started in production since.
   * The gate is gone rather than relaxed: every one of them reads Postgres or
   * self-gates on its own dependency, and `db/__tests__/bootWiring.test.ts`
   * walks the import graph from this file to assert no Mongoose driver is
   * reachable from it at all.
   *
   * Called here, after `listen`, for the same reason the seeders are not called
   * here at all: nothing on the boot path may stand between the process and
   * `/health/live` answering.
   */
  startBackgroundServices();

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

    // Release the leader lease, stop draining the outbox, drain the queues and
    // tear down the container pool — the mirror of `startBackgroundServices()`,
    // and asserted to be its exact mirror in `lib/__tests__/background-services.test.ts`.
    await stopBackgroundServices();

    // Close Redis connections
    const { closeRedis } = await import('./lib/redis.js');
    await closeRedis();
    log.general.info('Redis connections closed');

    // Close MCP relay connections
    shutdownMcpRelay();

    // Stop sweeping before the pool closes, so a sweep in flight is not cut off
    // mid-statement by the handle disappearing underneath it.
    stopExpirySweeper();

    // Close the Postgres pool last: it is the store every ported route reads, so
    // it stays open until everything that could still be using it has stopped.
    await closePostgres();
    log.general.info('Postgres pool closed');

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
