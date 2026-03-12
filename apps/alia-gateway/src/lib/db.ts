import mongoose from 'mongoose';
import { log } from './logger';

// Share the same database as the main API — the gateway manages
// a subset of collections (provider keys, models, plans, etc.)
// within the shared alia-{env} database.
const APP_NAME = 'alia';

function getDatabaseName(): string {
  const env = process.env.NODE_ENV || 'development';
  return `${APP_NAME}-${env}`;
}

let connectionPromise: Promise<typeof mongoose> | null = null;
let listenersRegistered = false;

function setupConnectionListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;

  const conn = mongoose.connection;

  conn.on('connected', () => {
    log.general.info('MongoDB connected');
  });

  conn.on('disconnected', () => {
    log.general.warn('MongoDB disconnected — mongoose will attempt to reconnect');
    connectionPromise = null;
  });

  conn.on('reconnected', () => {
    log.general.info('MongoDB reconnected');
  });

  conn.on('error', (err) => {
    log.general.error({ err }, 'MongoDB connection error');
  });
}

export async function connectDB(): Promise<typeof mongoose> {
  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/alia';

  if (!MONGODB_URI) {
    throw new Error('Please define the MONGODB_URI environment variable inside .env');
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  const dbName = getDatabaseName();

  const opts = {
    dbName,
    bufferCommands: false,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    heartbeatFrequencyMS: 10000,
  };

  // Register connection event listeners before connecting
  setupConnectionListeners();

  log.general.info({ dbName }, 'Connecting to MongoDB...');

  connectionPromise = mongoose.connect(MONGODB_URI, opts)
    .then((mongooseInstance) => {
      log.general.info({ dbName }, 'MongoDB connected successfully');
      return mongooseInstance;
    })
    .catch((err) => {
      log.general.error({ err }, 'Error connecting to MongoDB');
      connectionPromise = null;
      throw err;
    });

  return connectionPromise;
}

export function isConnected() {
  return mongoose.connection.readyState === 1;
}
