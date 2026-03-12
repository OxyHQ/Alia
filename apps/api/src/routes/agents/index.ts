import { Router } from 'express';
import crudRouter from './crud.js';
import generateRouter from './generate.js';
import hireRouter from './hire.js';
import sessionsRouter from './sessions.js';
import filesRouter from './files.js';
import reviewsRouter from './reviews.js';
import activityRouter from './activity.js';

const router = Router();

// Mount sub-routers
// Order matters: specific path prefixes before parameterized ones

// Generate must be before crud (which has /:id)
router.use('/', generateRouter);

// Files and session-specific routes (sessions/:sid/...) before parameterized /:id routes
router.use('/', filesRouter);
router.use('/', sessionsRouter);

// Activity, hire, and reviews use /:id prefix
router.use('/', activityRouter);
router.use('/', hireRouter);
router.use('/', reviewsRouter);

// CRUD last (has catch-all /:id routes)
router.use('/', crudRouter);

export default router;
