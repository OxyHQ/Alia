import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import mongoose from 'mongoose';
import { OxyServices } from '@oxyhq/core';
import { connectDB } from './lib/db';
import { log } from './lib/logger';
import { runStartupSeed } from './lib/seed-model-configs';
import { stopHealthCheckMonitor } from './lib/provider-health';
import { authenticateService } from './middleware/auth';
import { providersWss } from './ws';
import providersModule from './router';
import resolveRouter from './routes/resolve';
import callRouter from './routes/call';
import reportRouter from './routes/report';
import dataRouter from './routes/data';

const app = express();
const PORT = parseInt(process.env.PORT || '9091', 10);

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['https://providers.alia.onl', 'http://localhost:5173', 'http://localhost:3001'];

app.use(helmet());
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// Public health check
app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'alia-providers-api', status: 'healthy' });
});

// Admin routes (existing admin panel UI)
app.use('/internal/providers', providersModule);

// Service-to-service API routes (require HMAC auth)
app.use('/api/resolve', authenticateService, resolveRouter);
app.use('/api/call', authenticateService, callRouter);
app.use('/api/report', authenticateService, reportRouter);
app.use('/api', authenticateService, dataRouter);

async function start() {
  await connectDB();
  await runStartupSeed();

  const server = app.listen(PORT, () => {
    log.general.info('alia-providers-api listening on port %d', PORT);
  });

  // WebSocket upgrade for /internal/providers/ws
  server.on('upgrade', (request, socket, head) => {
    try {
      const pathname = new URL(request.url!, `http://${request.headers.host}`).pathname;

      if (pathname === '/internal/providers/ws') {
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
  const shutdown = async () => {
    log.general.info('Shutting down...');
    stopHealthCheckMonitor();
    server.close();
    await mongoose.connection.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  log.general.fatal({ err }, 'Failed to start alia-providers-api');
  process.exit(1);
});
