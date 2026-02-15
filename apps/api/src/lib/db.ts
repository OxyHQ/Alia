import mongoose from 'mongoose';
import { log } from './logger.js';

const APP_NAME = "alia";

function getDatabaseName(): string {
  const env = process.env.NODE_ENV || "development";
  return `${APP_NAME}-${env}`;
}

// Singleton promise to ensure only one connection attempt at a time
let connectionPromise: Promise<typeof mongoose> | null = null;

export async function connectDB() {
  // Read MONGODB_URI here, after dotenv.config() has been called
  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/alia';

  if (!MONGODB_URI) {
    throw new Error('Please define the MONGODB_URI environment variable inside .env');
  }

  // If already connected, return the mongoose instance
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  // If a connection attempt is in progress, wait for it
  if (connectionPromise) {
    return connectionPromise;
  }

  const dbName = getDatabaseName();

  // Create a new connection
  const opts = {
    dbName,
    bufferCommands: false,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10000, // Increased from 5s to 10s for production
    socketTimeoutMS: 45000,
  };

  log.general.info('Connecting to MongoDB...');

  connectionPromise = mongoose.connect(MONGODB_URI, opts)
    .then((mongooseInstance) => {
      log.general.info('MongoDB connected successfully');
      return mongooseInstance;
    })
    .catch((err) => {
      log.general.error({ err }, 'Error connecting to MongoDB');
      connectionPromise = null; // Reset to allow retry
      throw err;
    });

  return connectionPromise;
}

// Función auxiliar para verificar si la conexión está activa
export function isConnected() {
  return mongoose.connection.readyState === 1;
}
