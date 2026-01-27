import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/alia';

let cachedConnection: typeof mongoose | null = null;
let connectionPromise: Promise<typeof mongoose> | null = null;

export async function connectDB(): Promise<typeof mongoose> {
  // Return cached connection if exists
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }

  // Return existing connection attempt if in progress
  if (connectionPromise) {
    return connectionPromise;
  }

  // Create new connection
  connectionPromise = mongoose
    .connect(MONGODB_URI, {
      bufferCommands: false,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    })
    .then((mongooseInstance) => {
      console.log('✅ MongoDB conectado exitosamente (alia-providers)');
      cachedConnection = mongooseInstance;
      connectionPromise = null;
      return mongooseInstance;
    })
    .catch((error) => {
      console.error('❌ Error al conectar a MongoDB (alia-providers):', error.message);
      connectionPromise = null;
      throw error;
    });

  return connectionPromise;
}

export async function disconnectDB(): Promise<void> {
  if (cachedConnection) {
    await mongoose.disconnect();
    cachedConnection = null;
    console.log('MongoDB desconectado (alia-providers)');
  }
}

// Handle process termination
process.on('SIGINT', async () => {
  await disconnectDB();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await disconnectDB();
  process.exit(0);
});
