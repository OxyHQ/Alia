import { Router } from 'express';
import workflowsRouter from './workflows.js';
import executeRouter from './execute.js';

const router = Router();

// Canvas routes
router.use('/workflows', workflowsRouter);
router.use('/execute', executeRouter);

export default router;
