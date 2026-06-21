import mongoose from 'mongoose';

/**
 * Ensure mongoose is connected.
 * The main API server establishes the mongoose connection at startup.
 * This function is a safety net for seed scripts and health monitoring
 * that may run before or outside the main server lifecycle.
 */
export async function connectDB(): Promise<typeof mongoose> {
  // Already connected — reuse existing connection
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  // Connecting in progress — wait for it
  if (mongoose.connection.readyState === 2) {
    return new Promise((resolve, reject) => {
      mongoose.connection.once('connected', () => resolve(mongoose));
      mongoose.connection.once('error', reject);
    });
  }

  // Not connected — connect (only happens in standalone scripts)
  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/alia';
  await mongoose.connect(MONGODB_URI, {
    bufferCommands: false,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
  });

  return mongoose;
}
