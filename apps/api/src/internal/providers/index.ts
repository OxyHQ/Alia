import express from 'express';
import { authenticateService } from './middleware/auth';
import providersRouter from './routes/providers';
import modelsRouter from './routes/models';
import aliaModelsRouter from './routes/alia-models';
import keysRouter from './routes/keys';
import usageRouter from './routes/usage';
import authHealthRouter from './routes/auth-health';
import fallbackStatsRouter from './routes/fallback-stats';

const providersModule = express.Router();

// Health check (no auth)
providersModule.get('/health', (_req, res) => {
  res.json({
    success: true,
    service: 'alia-providers (internal)',
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

// API routes (require HMAC service auth or Bearer token auth)
providersModule.use('/v1/providers', authenticateService, providersRouter);
providersModule.use('/v1/models', authenticateService, modelsRouter);
providersModule.use('/v1/alia-models', authenticateService, aliaModelsRouter);
providersModule.use('/v1/keys', authenticateService, keysRouter);
providersModule.use('/v1/usage', authenticateService, usageRouter);
providersModule.use('/v1/auth-health', authenticateService, authHealthRouter);
providersModule.use('/v1/fallback-stats', authenticateService, fallbackStatsRouter);

export default providersModule;
