import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import providersRouter from './routes/providers';
import modelsRouter from './routes/models';
import keysRouter from './routes/keys';

const app = express();

// CORS Configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : [
      'http://localhost:5173', // Admin panel dev
      'http://localhost:3001', // Main API dev
      'https://providers.alia.onl', // Admin panel production
      'https://api.alia.onl', // Main API production
    ];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);

      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        console.warn(`⚠️  CORS blocked request from origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Service-Name', 'X-Timestamp', 'X-Signature'],
  })
);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Health check endpoint (no auth required)
app.get('/health', (req: Request, res: Response) => {
  res.json({
    success: true,
    service: 'alia-providers',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// API Routes (require authentication)
app.use('/v1/providers', providersRouter);
app.use('/v1/models', modelsRouter);
app.use('/v1/keys', keysRouter);

// Root endpoint
app.get('/', (req: Request, res: Response) => {
  res.json({
    service: 'Alia Providers',
    version: '1.0.0',
    description: 'Centralized provider management and API key handling',
    endpoints: {
      health: 'GET /health',
      providers: {
        resolve: 'POST /v1/providers/resolve',
        proxy: 'POST /v1/providers/:provider/proxy',
        health: 'GET /v1/providers/health',
        recordHealth: 'POST /v1/providers/health/record',
      },
      models: {
        list: 'GET /v1/models',
        get: 'GET /v1/models/:provider/:modelId',
        create: 'POST /v1/models',
        update: 'PATCH /v1/models/:provider/:modelId',
      },
      keys: {
        list: 'GET /v1/keys',
        create: 'POST /v1/keys',
        update: 'PATCH /v1/keys/:keyId',
        delete: 'DELETE /v1/keys/:keyId',
        rotate: 'POST /v1/keys/:keyId/rotate',
      },
    },
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path,
  });
});

// Error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

export default app;
