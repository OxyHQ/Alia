import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  findAutomationDefinition,
  listActiveAutomationAuthorizations,
  listAutomationDefinitions,
  listAutomationRuns,
  listAutomationRunSteps,
  markAutomationAuthorizationsRevoked,
  setAutomationEnabled,
} from '../db/automation/automationDefinitionRepository.js';
import { getDb } from '../db/index.js';
import {
  revokeAutomationAuthorizations,
} from '../lib/automation-authority.js';
import { dispatchStructuredAutomation } from '../lib/automation-dispatcher.js';
import { log } from '../lib/logger.js';
import {
  AutomationCreationError,
  createAutomationSchema,
  createStructuredAutomation,
  refreshAutomationSchedule,
  updateAutomationSchema,
  updateStructuredAutomation,
} from '../lib/structured-automation-creation.js';
import { authenticateToken } from '../middleware/auth.js';

type AutomationRecord = NonNullable<Awaited<ReturnType<typeof findAutomationDefinition>>>;

const idempotencyKeySchema = z.string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const router = Router();
router.use(authenticateToken);

function userId(request: Request): string | null {
  return request.user?.id ?? null;
}

async function stopAutomation(input: {
  request: Request;
  ownerAccountId: string;
  automation: AutomationRecord;
}) {
  const stopped = await setAutomationEnabled(getDb(), input.automation.id, input.ownerAccountId, false);
  await refreshAutomationSchedule(input.automation.id);
  const active = await listActiveAutomationAuthorizations(getDb(), input.automation.id);
  if (active.length === 0) return { automation: stopped, revoked: 0, failed: 0 };
  if (!input.request.accessToken) {
    log.triggers.error(
      { automationId: input.automation.id, count: active.length },
      'Automation stopped locally but no user session was available to revoke Oxy authority',
    );
    return { automation: stopped, revoked: 0, failed: active.length };
  }
  const result = await revokeAutomationAuthorizations(
    input.request.accessToken,
    active.map((authorization) => authorization.oxyAuthorizationId),
  );
  await markAutomationAuthorizationsRevoked(getDb(), result.revoked);
  if (result.failed.length > 0) {
    log.triggers.error(
      { automationId: input.automation.id, failed: result.failed.length },
      'Automation stopped locally; some Oxy authorizations still require revocation',
    );
  }
  return { automation: stopped, revoked: result.revoked.length, failed: result.failed.length };
}

router.get('/', async (request: Request, response: Response) => {
  const ownerAccountId = userId(request);
  if (!ownerAccountId) return response.status(401).json({ error: 'Unauthorized' });
  return response.json({ automations: await listAutomationDefinitions(getDb(), ownerAccountId) });
});

router.post('/', async (request: Request, response: Response) => {
  const ownerAccountId = userId(request);
  if (!ownerAccountId) return response.status(401).json({ error: 'Unauthorized' });
  const parsed = createAutomationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'invalid_automation', details: parsed.error.flatten() });
  }
  try {
    const created = await createStructuredAutomation({
      ownerAccountId,
      accessToken: request.accessToken,
      definition: parsed.data,
    });
    return response.status(201).json(created);
  } catch (error: unknown) {
    if (error instanceof AutomationCreationError) {
      return response.status(error.status).json({ error: error.code, ...error.context });
    }
    log.triggers.error({ err: error, ownerAccountId }, 'Unexpected automation creation failure');
    return response.status(503).json({ error: 'automation_store_unavailable' });
  }
});

router.get('/runs', async (request: Request, response: Response) => {
  const ownerAccountId = userId(request);
  if (!ownerAccountId) return response.status(401).json({ error: 'Unauthorized' });
  const automationId = typeof request.query.automationId === 'string' ? request.query.automationId : undefined;
  return response.json({ runs: await listAutomationRuns(getDb(), ownerAccountId, automationId) });
});

router.get('/runs/:runId/steps', async (request: Request, response: Response) => {
  const ownerAccountId = userId(request);
  if (!ownerAccountId) return response.status(401).json({ error: 'Unauthorized' });
  const runs = await listAutomationRuns(getDb(), ownerAccountId);
  if (!runs.some((run) => run.id === request.params.runId)) {
    return response.status(404).json({ error: 'Run not found' });
  }
  return response.json({ steps: await listAutomationRunSteps(getDb(), String(request.params.runId)) });
});

router.post('/:id/run', async (request: Request, response: Response) => {
  const ownerAccountId = userId(request);
  if (!ownerAccountId) return response.status(401).json({ error: 'Unauthorized' });
  const idempotencyKey = idempotencyKeySchema.safeParse(request.get('idempotency-key'));
  if (!idempotencyKey.success) {
    return response.status(400).json({ error: 'valid_idempotency_key_required' });
  }
  const automation = await findAutomationDefinition(
    getDb(),
    String(request.params.id),
    ownerAccountId,
  );
  if (!automation) return response.status(404).json({ error: 'Automation not found' });
  if (automation.trigger.type !== 'manual') {
    return response.status(409).json({ error: 'automation_trigger_is_not_manual' });
  }

  try {
    const run = await dispatchStructuredAutomation(automation, {
      kind: 'manual',
      id: `manual:${automation.id}:${idempotencyKey.data}`,
      occurredAt: new Date(),
      requesterAccountId: ownerAccountId,
    });
    return response.status(run.status === 'queued' ? 202 : run.status === 'denied' ? 409 : 200).json({ run });
  } catch (error: unknown) {
    log.triggers.error({ err: error, automationId: automation.id }, 'Could not dispatch manual automation');
    return response.status(503).json({ error: 'automation_dispatch_unavailable' });
  }
});

router.patch('/:id', async (request: Request, response: Response) => {
  const ownerAccountId = userId(request);
  if (!ownerAccountId) return response.status(401).json({ error: 'Unauthorized' });
  const parsed = updateAutomationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      error: 'invalid_automation_patch',
      details: parsed.error.flatten(),
    });
  }
  const existing = await findAutomationDefinition(getDb(), String(request.params.id), ownerAccountId);
  if (!existing) return response.status(404).json({ error: 'Automation not found' });
  try {
    return response.json(await updateStructuredAutomation({
      ownerAccountId,
      accessToken: request.accessToken,
      existing,
      patch: parsed.data,
    }));
  } catch (error: unknown) {
    if (error instanceof AutomationCreationError) {
      return response.status(error.status).json({ error: error.code, ...error.context });
    }
    log.triggers.error({ err: error, automationId: existing.id }, 'Unexpected automation update failure');
    return response.status(503).json({ error: 'automation_store_unavailable' });
  }
});

router.delete('/:id', async (request: Request, response: Response) => {
  const ownerAccountId = userId(request);
  if (!ownerAccountId) return response.status(401).json({ error: 'Unauthorized' });
  const existing = await findAutomationDefinition(getDb(), String(request.params.id), ownerAccountId);
  if (!existing) return response.status(404).json({ error: 'Automation not found' });
  const stopped = await stopAutomation({ request, ownerAccountId, automation: existing });
  log.triggers.info({ automationId: existing.id, ownerAccountId }, 'Automation stopped');
  return response.json({
    automation: stopped.automation,
    stopped: true,
    revocation: { revoked: stopped.revoked, failed: stopped.failed },
  });
});

export default router;
