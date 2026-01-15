import { Router } from 'express';
import chatCompletionsRouter from './v1/chat-completions.js';
import modelsRouter from './v1/models.js';

const router = Router();

router.get('/', (req, res) => {
  res.json({
    message: 'AI Platform API v1',
    version: '1.0.0'
  });
});

router.use('/chat/completions', chatCompletionsRouter);
router.use('/models', modelsRouter);

export default router;
