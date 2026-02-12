import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import { sessionManager } from './session-manager';
import sessionsRouter from './routes/sessions';

const PORT = process.env.PORT || 3002;
const MONGODB_URI = process.env.MONGODB_URI;
const APP_NAME = 'whatsapp-gateway';

// Validate required environment variables
if (!MONGODB_URI) {
  console.error('MONGODB_URI is required');
  process.exit(1);
}

if (!process.env.WHATSAPP_GATEWAY_SECRET) {
  console.error('WHATSAPP_GATEWAY_SECRET is required');
  process.exit(1);
}

async function main() {
  // Connect to MongoDB with app-specific database name
  const dbName = `${APP_NAME}-${process.env.NODE_ENV || 'development'}`;
  await mongoose.connect(MONGODB_URI!, { dbName });
  console.log(`[WhatsApp Gateway] Connected to MongoDB (${dbName})`);

  // Initialize session manager (reconnects existing sessions)
  await sessionManager.initialize();

  // Start Express server
  const app = express();
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: APP_NAME, uptime: process.uptime() });
  });

  // Session management routes
  app.use('/sessions', sessionsRouter);

  app.listen(PORT, () => {
    console.log(`[WhatsApp Gateway] Running on port ${PORT}`);
  });
}

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`[WhatsApp Gateway] Received ${signal}, shutting down gracefully...`);

  try {
    // Disconnect all WhatsApp sessions
    await sessionManager.shutdown();

    // Close MongoDB connection
    await mongoose.disconnect();
    console.log('[WhatsApp Gateway] MongoDB disconnected');
  } catch (err) {
    console.error('[WhatsApp Gateway] Error during shutdown:', err);
  }

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  console.error('[WhatsApp Gateway] Fatal error:', err);
  process.exit(1);
});
