import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { connectDB } from './lib/db.js';

// Routes
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import conversationsRouter from './routes/conversations.js';
import foldersRouter from './routes/folders.js';
import chatRouter from './routes/chat.js';
import memoryRouter from './routes/memory.js';
import creditsRouter from './routes/credits.js';
import v1Router from './routes/v1.js';
import telegramRouter from './routes/telegram.js';
import developerRouter from './routes/developer.js';
import billingRouter from './routes/billing.js';
import organizationRouter from './routes/organization.js';
import canvasRouter from './routes/canvas/index.js';
import feedbackRouter from './routes/feedback.js';
import codeaRouter from './routes/codea.js';
import modelsStatsRouter from './routes/models-stats.js';
import externalModelsRouter from './routes/external-models.js';
import internalRouter from './routes/internal.js';
import providersModule from './internal/providers/index.js';
import { providersWss } from './internal/providers/ws.js';
import { oxyClient } from './middleware/auth.js';
import { OxyServices } from '@oxyhq/core';
import { syncZeroEval } from './scripts/sync-zeroeval.js';
import { runStartupSeed } from './internal/providers/lib/seed-model-configs.js';

// WebSocket and Socket.io
import { WebSocketServer } from 'ws';
import { setupRealtimeEndpoint } from './routes/v1/realtime.js';
import { initSocket } from './socket.js';

// Fix for ES Modules __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from the api directory (not the monorepo root)
dotenv.config({ path: join(__dirname, '../.env') });

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

// Optimize server for SSE streaming
server.on('connection', (socket) => {
  // Disable Nagle's algorithm for all connections to reduce latency
  socket.setNoDelay(true);
  // Set keep-alive
  socket.setKeepAlive(true, 60000);
});

initSocket(server);

const wss = new WebSocketServer({
  noServer: true,
  clientTracking: true,
  maxPayload: 10 * 1024 * 1024, // 10MB max payload for audio
});

// Handle WebSocket upgrade for /v1/realtime path
server.on('upgrade', (request, socket, head) => {
  try {
    const pathname = new URL(request.url!, `http://${request.headers.host}`).pathname;

    if (pathname === '/v1/realtime') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (pathname === '/internal/providers/ws') {
      // Validate JWT access token from query string
      const url = new URL(request.url!, `http://${request.headers.host}`);
      const token = url.searchParams.get('token');
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      // Validate token using per-request OxyServices instance
      const perRequestOxy = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });
      perRequestOxy.setTokens(token);
      perRequestOxy.validate().then(({ valid }: { valid: boolean }) => {
        if (!valid) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        providersWss.handleUpgrade(request, socket, head, (ws) => {
          providersWss.emit('connection', ws, request);
        });
      }).catch(() => {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      });
    } else {
      socket.destroy();
    }
  } catch (error) {
    console.error('[Server] Error during WebSocket upgrade:', error);
    socket.destroy();
  }
});

// Setup realtime endpoint
setupRealtimeEndpoint(wss);

// Public API routes (/v1) - allow all origins
app.use('/v1', cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200
}));

// Internal routes - restricted to known origins
const PRODUCTION_ORIGINS = [
  'https://alia.onl',
  'https://console.alia.onl',
  'https://providers.alia.onl',
];

const DEV_ORIGINS = process.env.NODE_ENV === 'production' ? [] : [
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

app.use(cors({
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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'X-Service-Name', 'X-Timestamp', 'X-Signature', 'X-Session-Id', 'X-Device-Info', 'X-Oxy-User-Id'],
  optionsSuccessStatus: 200
}));

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
app.use('/telegram', telegramRouter);
app.use('/developer', developerRouter);
app.use('/billing', billingRouter);
app.use('/organization', organizationRouter);
app.use('/feedback', feedbackRouter);
app.use('/api', canvasRouter);
app.use('/codea', codeaRouter);
app.use('/models', modelsStatsRouter);
app.use('/external-models', externalModelsRouter);
app.use('/internal', internalRouter);
app.use('/internal/providers', providersModule);

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
      '/telegram',
      '/developer',
      '/billing',
      '/organization',
      '/feedback',
      '/codea',
      '/models',
      '/external-models',
      '/internal/trigger',
      '/internal/providers'
    ]
  });
});

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Connect to MongoDB before starting the server
connectDB()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 API Server running on http://0.0.0.0:${PORT}`);
      // Seed model configs and reset circuit breakers (non-blocking)
      runStartupSeed().catch((err) => console.error('[Seed] Startup seed error:', err));
      // Sync external models in background (non-blocking)
      syncZeroEval().catch((err) => console.error('[ZeroEval] Background sync error:', err));
    });
  })
  .catch((error) => {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  });
