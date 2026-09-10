/** Read-only history for trigger rows retired by the structured automation cutover. */

import { Router, type Request, type Response } from 'express';
import {
  countTriggerExecutions,
  findTriggerForUser,
  listTriggerExecutions,
  listTriggers,
} from '../db/automation/triggerRepository.js';
import type { TriggerTypeValue } from '../db/schema/automation.js';
import { getDb } from '../db/index.js';
import { log } from '../lib/logger.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();
const authRouter = Router();
authRouter.use(authenticateToken);

function retiredWrite(_request: Request, response: Response): Response {
  return response.status(410).json({
    error: 'legacy_trigger_write_retired',
    replacement: '/automations',
  });
}

authRouter.get('/', async (request: Request, response: Response) => {
  try {
    if (!request.user?.id) return response.status(401).json({ error: 'Unauthorized' });
    const type = request.query.type;
    const narrowed = ['schedule', 'webhook', 'integration_event'].includes(String(type))
      ? type as TriggerTypeValue
      : undefined;
    const triggers = await listTriggers(getDb(), request.user.id, { type: narrowed });
    return response.json({ triggers });
  } catch (error: unknown) {
    log.triggers.error({ err: error }, 'Error listing retired triggers');
    return response.status(500).json({ error: 'Failed to list triggers' });
  }
});

authRouter.get('/:id', async (request: Request, response: Response) => {
  try {
    if (!request.user?.id) return response.status(401).json({ error: 'Unauthorized' });
    const trigger = await findTriggerForUser(
      getDb(),
      String(request.params.id),
      request.user.id,
    );
    return trigger
      ? response.json({ trigger })
      : response.status(404).json({ error: 'Trigger not found' });
  } catch (error: unknown) {
    log.triggers.error({ err: error }, 'Error getting retired trigger');
    return response.status(500).json({ error: 'Failed to get trigger' });
  }
});

authRouter.get('/:id/executions', async (request: Request, response: Response) => {
  try {
    if (!request.user?.id) return response.status(401).json({ error: 'Unauthorized' });
    const trigger = await findTriggerForUser(
      getDb(),
      String(request.params.id),
      request.user.id,
    );
    if (!trigger) return response.status(404).json({ error: 'Trigger not found' });
    const rawLimit = typeof request.query.limit === 'string' ? request.query.limit : '';
    const rawOffset = typeof request.query.offset === 'string' ? request.query.offset : '';
    const limit = Math.min(Number.parseInt(rawLimit, 10) || 20, 100);
    const offset = Number.parseInt(rawOffset, 10) || 0;
    const [executions, total] = await Promise.all([
      listTriggerExecutions(getDb(), trigger._id, { limit, offset }),
      countTriggerExecutions(getDb(), trigger._id),
    ]);
    return response.json({ executions, total, limit, offset });
  } catch (error: unknown) {
    log.triggers.error({ err: error }, 'Error listing retired trigger executions');
    return response.status(500).json({ error: 'Failed to list executions' });
  }
});

authRouter.post('/', retiredWrite);
authRouter.patch('/:id', retiredWrite);
authRouter.delete('/:id', retiredWrite);
authRouter.post('/:id/run', retiredWrite);
authRouter.post('/:id/regenerate-token', retiredWrite);
router.post('/webhook/:token', retiredWrite);
router.use('/', authRouter);

export default router;
