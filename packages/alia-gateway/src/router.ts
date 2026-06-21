import express from 'express';
import mongoose from 'mongoose';
import { authenticateService } from './middleware/auth';
import providersRouter from './routes/providers';
import modelsRouter from './routes/models';
import aliaModelsRouter from './routes/alia-models';
import keysRouter from './routes/keys';
import usageRouter from './routes/usage';
import fallbackStatsRouter from './routes/fallback-stats';
import plansRouter from './routes/plans';
import creditPackagesRouter from './routes/credit-packages';
import billingAdminRouter from './routes/billing-admin';
import featuresRouter from './routes/features';
import planFeaturesRouter from './routes/plan-features';
import dashboardStatsRouter from './routes/dashboard-stats';
import logsRouter from './routes/logs';

const providersModule = express.Router();

// Detailed health (auth-protected) — includes memory, uptime, MongoDB state
providersModule.get('/v1/health-details', authenticateService, (_req, res) => {
  const mongoState = mongoose.connection.readyState;
  const isHealthy = mongoState === 1;
  const mem = process.memoryUsage();

  res.json({
    status: isHealthy ? 'healthy' : 'degraded',
    mongodb: mongoState === 1 ? 'connected'
      : mongoState === 2 ? 'connecting'
      : mongoState === 3 ? 'disconnecting'
      : 'disconnected',
    uptime: Math.round(process.uptime()),
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
  });
});

// API routes (require HMAC service auth or Bearer token auth)
providersModule.use('/v1/providers', authenticateService, providersRouter);
providersModule.use('/v1/models', authenticateService, modelsRouter);
providersModule.use('/v1/alia-models', authenticateService, aliaModelsRouter);
providersModule.use('/v1/keys', authenticateService, keysRouter);
providersModule.use('/v1/usage', authenticateService, usageRouter);
providersModule.use('/v1/fallback-stats', authenticateService, fallbackStatsRouter);
providersModule.use('/v1/plans', authenticateService, plansRouter);
providersModule.use('/v1/credit-packages', authenticateService, creditPackagesRouter);
providersModule.use('/v1/billing', authenticateService, billingAdminRouter);
providersModule.use('/v1/features', authenticateService, featuresRouter);
providersModule.use('/v1/plan-features', authenticateService, planFeaturesRouter);
providersModule.use('/v1/dashboard-stats', authenticateService, dashboardStatsRouter);
providersModule.use('/v1/logs', authenticateService, logsRouter);

export default providersModule;
