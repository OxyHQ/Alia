import { Router } from 'express';
import crudRouter from './crud.js';
import generateRouter from './generate.js';
import threadRouter from './thread.js';
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

// Before the `/:id/...` routers, and this one really is load-bearing.
//
// Every two-segment route below has a LITERAL second segment — `/:id/activity`,
// `/:id/reviews`, `/:id/hire`, `/:id/sessions` — so `/thread/pepe` matches none
// of them. `/thread/activity` matches `/:id/activity` exactly, with the id read
// as the word `thread`. Oxy usernames are free-form, so `@activity` is a handle
// somebody may hold, and mounted later this router would never see them.
router.use('/', threadRouter);

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
