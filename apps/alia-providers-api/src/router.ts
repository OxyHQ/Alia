import express from 'express';
import { authenticateService } from './middleware/auth';
import providersRouter from './routes/providers';
import modelsRouter from './routes/models';
import aliaModelsRouter from './routes/alia-models';
import keysRouter from './routes/keys';
import usageRouter from './routes/usage';
import authHealthRouter from './routes/auth-health';
import fallbackStatsRouter from './routes/fallback-stats';
import plansRouter from './routes/plans';
import creditPackagesRouter from './routes/credit-packages';
import billingAdminRouter from './routes/billing-admin';
import featuresRouter from './routes/features';
import planFeaturesRouter from './routes/plan-features';

const providersModule = express.Router();

// API routes (require HMAC service auth or Bearer token auth)
providersModule.use('/v1/providers', authenticateService, providersRouter);
providersModule.use('/v1/models', authenticateService, modelsRouter);
providersModule.use('/v1/alia-models', authenticateService, aliaModelsRouter);
providersModule.use('/v1/keys', authenticateService, keysRouter);
providersModule.use('/v1/usage', authenticateService, usageRouter);
providersModule.use('/v1/auth-health', authenticateService, authHealthRouter);
providersModule.use('/v1/fallback-stats', authenticateService, fallbackStatsRouter);
providersModule.use('/v1/plans', authenticateService, plansRouter);
providersModule.use('/v1/credit-packages', authenticateService, creditPackagesRouter);
providersModule.use('/v1/billing', authenticateService, billingAdminRouter);
providersModule.use('/v1/features', authenticateService, featuresRouter);
providersModule.use('/v1/plan-features', authenticateService, planFeaturesRouter);

export default providersModule;
