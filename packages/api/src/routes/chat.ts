import { Router } from 'express';
import { optionalAuth } from '../middleware/auth.js';
import { handleChatCompletions } from './v1/chat-completions.js';

const router = Router();

// Unified runtime: internal chat now uses the same handler as /v1/chat/completions.
router.post('/', optionalAuth, handleChatCompletions);

router.get('/', async (_req, res) => {
  res.json({
    status: '🟢 Online',
    service: 'Alia AI Chat',
    endpoint: '/alia/chat',
    runtime: 'autonomy-v1',
  });
});

export default router;
