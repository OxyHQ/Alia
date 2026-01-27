import express from 'express';
import { authenticateService } from './middleware/auth';
import providersRouter from './routes/providers';
import modelsRouter from './routes/models';
import keysRouter from './routes/keys';

const providersModule = express.Router();

// Health check (no auth)
providersModule.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'alia-providers (internal)',
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

// API routes (require HMAC auth for admin panel)
providersModule.use('/v1/providers', authenticateService, providersRouter);
providersModule.use('/v1/models', authenticateService, modelsRouter);
providersModule.use('/v1/keys', authenticateService, keysRouter);

export default providersModule;
