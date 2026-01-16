import mongoose from 'mongoose';

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

  // Create a new connection
  const opts = {
    bufferCommands: false,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10000, // Increased from 5s to 10s for production
    socketTimeoutMS: 45000,
  };

  console.log('🔄 Conectando a MongoDB...');

  connectionPromise = mongoose.connect(MONGODB_URI, opts)
    .then((mongooseInstance) => {
      console.log('✅ MongoDB conectado exitosamente');
      return mongooseInstance;
    })
    .catch((err) => {
      console.error('❌ Error conectando a MongoDB:', err);
      connectionPromise = null; // Reset to allow retry
      throw err;
    });

  return connectionPromise;
}

// Función auxiliar para verificar si la conexión está activa
export function isConnected() {
  return mongoose.connection.readyState === 1;
}
