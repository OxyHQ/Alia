import 'dotenv/config';
import { startPlatformActivity } from './platform-activity.js';
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

let activityReady = false;
const activity = startPlatformActivity(() => activityReady);
const app = express();
if (activity) app.use(activity.observeHttp);
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

  const server = app.listen(PORT, () => {
    activityReady = true;
    log.info('alia-docker-api listening on port %d', PORT);
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    activityReady = false;
    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await activity?.stop();
    clearTimeout(timeout);
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
}

start().catch(err => {
  log.fatal({ err }, 'Failed to start');
  process.exit(1);
});
