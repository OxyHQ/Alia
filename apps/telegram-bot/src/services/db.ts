import mongoose from 'mongoose';

let isConnected = false;

export async function connectToDatabase(): Promise<void> {
  if (isConnected) {
    console.log('Using existing database connection');
    return;
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI environment variable is not set');
  }

  try {
    await mongoose.connect(mongoUri, {
      maxPoolSize: 10,
    });

    isConnected = true;
    console.log('Connected to MongoDB');
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    throw error;
  }
}

mongoose.connection.on('connected', () => {
  console.log('Mongoose connected to MongoDB');
});

mongoose.connection.on('error', (err) => {
  console.error('Mongoose connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('Mongoose disconnected');
  isConnected = false;
});
