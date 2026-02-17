import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pino from 'pino';
import { authMiddleware } from './middleware/auth.js';
import { containersRouter } from './routes/containers.js';
import { healthRouter } from './routes/health.js';
import { ensureNetwork } from './lib/docker.js';
import { startCleanupLoop } from './lib/cleanup.js';

export const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty' },
  }),
});

const app = express();
const PORT = parseInt(process.env.PORT || '9090', 10);

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check (no auth required)
app.use('/health', healthRouter);

// All other routes require auth
app.use(authMiddleware);
app.use('/containers', containersRouter);

async function start() {
  await ensureNetwork();
  startCleanupLoop();

  app.listen(PORT, () => {
    log.info('alia-docker-api listening on port %d', PORT);
  });
}

start().catch(err => {
  log.fatal({ err }, 'Failed to start');
  process.exit(1);
});
