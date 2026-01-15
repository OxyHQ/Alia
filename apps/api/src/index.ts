import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Importar rutas
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import conversationsRouter from './routes/conversations.js';
import foldersRouter from './routes/folders.js';
import chatRouter from './routes/chat.js';
import memoryRouter from './routes/memory.js';
import uploadRouter from './routes/upload.js';
import creditsRouter from './routes/credits.js';
import v1Router from './routes/v1.js';

// Fix for ES Modules __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from the api directory (not the monorepo root)
dotenv.config({ path: join(__dirname, '../.env') });

const app = express();
const PORT = process.env.API_PORT || 3001;

// Middleware - Allow multiple origins for web and mobile app
const allowedOrigins = [
  process.env.WEB_URL || 'http://localhost:3000',  // Admin/Web app
  'http://localhost:8081',  // Expo web dev server
  'exp://localhost:8081',   // Expo mobile
  'http://10.0.2.2:8081',   // Android emulator
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// MongoDB connection is handled by db.ts when needed

// Rutas
app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/folders', foldersRouter);
app.use('/api/memory', memoryRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/credits', creditsRouter);
app.use('/api/alia/chat', chatRouter);
app.use('/api/v1', v1Router);

// Ruta raíz
app.get('/api', (req, res) => {
  res.json({
    message: 'Alia API',
    version: '1.0.0',
    endpoints: [
      '/api/health',
      '/api/auth',
      '/api/conversations',
      '/api/folders',
      '/api/memory',
      '/api/upload',
      '/api/credits',
      '/api/alia/chat',
      '/api/v1'
    ]
  });
});

// Manejo de errores
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(PORT, () => {
  console.log(`🚀 API Server running on http://localhost:${PORT}`);
});
