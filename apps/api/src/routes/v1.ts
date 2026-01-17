import { Router } from 'express';
import chatCompletionsRouter from './v1/chat-completions.js';
import modelsRouter from './v1/models.js';
import { authenticateTokenOrApiKey } from '../middleware/auth.js';

const router = Router();

// Debug middleware to log all v1 requests
router.use((req, res, next) => {
  console.log(`[V1] ${req.method} ${req.path}`);
  console.log('[V1] Headers:', JSON.stringify(req.headers, null, 2));
  console.log('[V1] Body type:', typeof req.body);
  console.log('[V1] Body is object:', typeof req.body === 'object' && req.body !== null);
  if (req.body && typeof req.body === 'object') {
    console.log('[V1] Body keys:', Object.keys(req.body));
    console.log('[V1] Has messages:', 'messages' in req.body);
  }
  next();
});

router.get('/', (req, res) => {
  res.json({
    message: 'AI Platform API v1',
    version: '1.0.0'
  });
});

// Apply authentication to all v1 routes (supports both JWT and API keys)
router.use(authenticateTokenOrApiKey);

router.use('/chat/completions', chatCompletionsRouter);
router.use('/models', modelsRouter);

export default router;
