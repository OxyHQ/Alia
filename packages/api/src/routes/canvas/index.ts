import { Router } from 'express';
import workflowsRouter from './workflows.js';
import executeRouter from './execute.js';
import sessionsRouter from './sessions.js';

const router = Router();

// Canvas routes
router.use('/workflows', workflowsRouter);
router.use('/execute', executeRouter);
router.use('/sessions', sessionsRouter);

export default router;
