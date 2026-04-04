import express from 'express';
import { log } from '../lib/logger.js';

const router = express.Router();

// Webhook endpoints for external service integrations
// Channel bot webhooks removed during Clarity pruning

router.post('/:type', (_req, res) => {
  log.webhook.warn({ type: _req.params.type }, 'Unhandled webhook type');
  res.sendStatus(404);
});

export default router;
