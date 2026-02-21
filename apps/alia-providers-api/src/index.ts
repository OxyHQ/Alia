import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import mongoose from 'mongoose';
import { OxyServices } from '@oxyhq/core';
import { connectDB } from './lib/db';
import { log } from './lib/logger';
import { isAbortError, isFatalError, isTransientNetworkError } from './lib/error-classification';
import { runStartupSeed } from './lib/seed-model-configs';
import { stopHealthCheckMonitor } from './lib/provider-health';
import { authenticateService } from './middleware/auth';
import { providersWss } from './ws';
import providersModule from './router';
import resolveRouter from './routes/resolve';
import callRouter from './routes/call';
import reportRouter from './routes/report';
import dataRouter from './routes/data';

// Process-level error handlers — prevent crashes from unhandled rejections
process.on('unhandledRejection', (reason) => {
  if (isAbortError(reason)) return;

  if (isFatalError(reason)) {
    log.general.error({ err: reason }, '[Process] FATAL unhandled rejection — shutting down');
    setTimeout(() => process.exit(1), 5000).unref();
    return;
  }

  if (isTransientNetworkError(reason)) {
    log.general.warn({ err: reason }, '[Process] Transient network error (continuing)');
    return;
  }

  log.general.error(
    { reason: reason instanceof Error ? reason : String(reason) },
    '[Process] Unhandled promise rejection',
  );
});

process.on('uncaughtException', (error) => {
  log.general.error({ err: error }, '[Process] Uncaught exception — shutting down');
  setTimeout(() => process.exit(1), 5000).unref();
});

const app = express();
const PORT = parseInt(process.env.PORT || '9091', 10);

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['https://providers.alia.onl', 'http://localhost:5173', 'http://localhost:3001'];

app.use(helmet());
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// Health check — reports actual service state
app.get('/health', (_req, res) => {
  const mongoState = mongoose.connection.readyState;
  const isHealthy = mongoState === 1;
  const mem = process.memoryUsage();

  res.status(isHealthy ? 200 : 503).json({
    success: isHealthy,
    service: 'alia-providers-api',
    status: isHealthy ? 'healthy' : 'degraded',
    mongodb: mongoState === 1 ? 'connected'
      : mongoState === 2 ? 'connecting'
      : mongoState === 3 ? 'disconnecting'
      : 'disconnected',
    uptime: Math.round(process.uptime()),
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
  });
});

// Liveness probe: process is running
app.get('/health/live', (_req, res) => {
  res.status(200).json({ status: 'alive' });
});

// Readiness probe: MongoDB connected
app.get('/health/ready', (_req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;
  if (!mongoReady) {
    return res.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
  }
  res.status(200).json({ status: 'ready' });
});

// Admin routes (existing admin panel UI)
app.use('/providers', providersModule);

// Service-to-service API routes (require HMAC auth)
app.use('/api/resolve', authenticateService, resolveRouter);
app.use('/api/call', authenticateService, callRouter);
app.use('/api/report', authenticateService, reportRouter);
app.use('/api', authenticateService, dataRouter);

// Global error handler — ensures JSON responses for unhandled middleware errors
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.general.error({ err }, 'Unhandled error');
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
});

async function start() {
  await connectDB();
  await runStartupSeed();

  const server = app.listen(PORT, () => {
    log.general.info('alia-providers-api listening on port %d', PORT);
  });

  // WebSocket upgrade for /providers/ws
  server.on('upgrade', (request, socket, head) => {
    try {
      const pathname = new URL(request.url!, `http://${request.headers.host}`).pathname;

      if (pathname === '/providers/ws') {
        const url = new URL(request.url!, `http://${request.headers.host}`);
        const token = url.searchParams.get('token');
        if (!token) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        const perRequestOxy = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });
        perRequestOxy.setTokens(token);
        perRequestOxy.validate().then((valid: boolean) => {
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
      log.general.error({ error }, 'Error during WebSocket upgrade');
      socket.destroy();
    }
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.general.info({ signal }, 'Starting graceful shutdown...');

    stopHealthCheckMonitor();

    // Stop accepting new connections
    server.close(() => {
      log.general.info('HTTP server closed (no new connections)');
    });

    // Close all WebSocket connections
    providersWss.clients.forEach((ws) => {
      ws.close(1001, 'Server shutting down');
    });

    // Force exit after 10 seconds if in-flight requests haven't completed
    const forceTimeout = setTimeout(() => {
      log.general.error('Force exit after 10s grace period');
      process.exit(1);
    }, 10000);
    forceTimeout.unref();

    try {
      await mongoose.connection.close();
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
}

start().catch((err) => {
  log.general.fatal({ err }, 'Failed to start alia-providers-api');
  process.exit(1);
});
