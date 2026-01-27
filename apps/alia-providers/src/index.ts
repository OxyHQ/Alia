import dotenv from 'dotenv';
import app from './app';
import { connectDB } from './lib/db';

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';

async function startServer() {
  try {
    // Connect to MongoDB
    console.log('🔄 Conectando a MongoDB...');
    await connectDB();

    // Start Express server
    app.listen(PORT, () => {
      console.log(`🚀 Alia Providers Service running on http://0.0.0.0:${PORT}`);
      console.log(`📦 Environment: ${NODE_ENV}`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();
