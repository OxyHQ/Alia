import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { connectDB } from './lib/db.js';

// Importar rutas
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
import modelsRouter from './routes/models.js';
import modelsStatsRouter from './routes/models-stats.js';
import providersModule from './internal/providers/index.js';

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

// Socket.io
import { initSocket } from './socket.js';
const io = initSocket(server);

// Middleware - Allow multiple origins for web and mobile app
const allowedOrigins = [
  process.env.WEB_URL || 'http://localhost:3000',
  'https://alia.onl',
  'http://localhost:8081',
  'exp://localhost:8081',
  'http://10.0.2.2:8081',
  'http://localhost:3002',
  'http://localhost:5173',
  'https://providers.alia.onl',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

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

// Rutas
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
app.use('/models', modelsRouter);
app.use('/models', modelsStatsRouter);
app.use('/internal/providers', providersModule);

// Ruta raíz
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
      '/internal/providers'
    ]
  });
});

// Manejo de errores
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Connect to MongoDB before starting the server
connectDB()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 API Server running on http://0.0.0.0:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  });
