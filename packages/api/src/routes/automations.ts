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
  provisionAutomationAuthorizations,
  revokeAutomationAuthorizations,
  type ProvisionedAutomationAuthorization,
} from '../lib/automation-authority.js';
import {
  uniqueAutomationResources,
} from '../lib/automation-coordination.js';
import { log } from '../lib/logger.js';
import {
  AutomationCreationError,
  createAutomationSchema,
  createStructuredAutomation,
  executionAuthorityPairs,
  ownedAutomationAgents,
  persistAutomationAuthorityAndActivate,
  refreshAutomationSchedule,
  revokeProvisionedAutomationAuthority,
} from '../lib/structured-automation-creation.js';
import { authenticateToken } from '../middleware/auth.js';

type AutomationRecord = NonNullable<Awaited<ReturnType<typeof findAutomationDefinition>>>;

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

router.patch('/:id', async (request: Request, response: Response) => {
  const ownerAccountId = userId(request);
  if (!ownerAccountId) return response.status(401).json({ error: 'Unauthorized' });
  const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'invalid_automation_patch' });
  const existing = await findAutomationDefinition(getDb(), String(request.params.id), ownerAccountId);
  if (!existing) return response.status(404).json({ error: 'Automation not found' });
  if (existing.enabled === parsed.data.enabled) return response.json({ automation: existing });

  if (!parsed.data.enabled) {
    const stopped = await stopAutomation({ request, ownerAccountId, automation: existing });
    return response.json({
      automation: stopped.automation,
      stopped: true,
      revocation: { revoked: stopped.revoked, failed: stopped.failed },
    });
  }

  if (existing.executionMode === 'execute') {
    if (!request.accessToken) {
      return response.status(401).json({ error: 'user_session_required_for_execution_authority' });
    }
    const agentIds = existing.actorSelection.mode === 'fixed'
      ? [existing.actorSelection.agentId].filter((id): id is string => Boolean(id))
      : existing.actorSelection.eligibleAgentIds;
    const agents = await ownedAutomationAgents(ownerAccountId, agentIds);
    if (!agents) return response.status(403).json({ error: 'automation_agent_not_owned' });
    const authorityPairs = await executionAuthorityPairs({
      ownerAccountId,
      agents,
      actions: existing.actions,
      sourceResources: uniqueAutomationResources([
        ...(existing.trigger.type === 'event' && existing.trigger.resource
          ? [existing.trigger.resource]
          : []),
        ...existing.dataFlow.sources,
      ]),
    });
    if (!authorityPairs) {
      return response.status(403).json({ error: 'automation_actor_coverage_missing' });
    }
    let provisioned: ProvisionedAutomationAuthorization[];
    try {
      provisioned = await provisionAutomationAuthorizations({
        accessToken: request.accessToken,
        ownerAccountId,
        automationId: existing.id,
        maximumAutonomy: existing.maximumAutonomy,
        pairs: authorityPairs,
      });
    } catch (error: unknown) {
      log.triggers.warn({ err: error, automationId: existing.id }, 'Oxy refused restored automation authority');
      return response.status(403).json({ error: 'automation_execution_authority_refused' });
    }
    try {
      const automation = await persistAutomationAuthorityAndActivate({
        automationId: existing.id,
        ownerAccountId,
        provisioned,
      });
      await refreshAutomationSchedule(existing.id);
      return response.json({ automation });
    } catch (error: unknown) {
      await revokeProvisionedAutomationAuthority(request.accessToken, provisioned);
      log.triggers.error({ err: error, automationId: existing.id }, 'Could not persist restored automation authority');
      return response.status(503).json({ error: 'automation_store_unavailable' });
    }
  }
  const automation = await setAutomationEnabled(getDb(), existing.id, ownerAccountId, true);
  await refreshAutomationSchedule(existing.id);
  return response.json({ automation });
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
