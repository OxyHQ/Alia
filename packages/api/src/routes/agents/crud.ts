import { Router } from 'express';
import { authenticateToken, optionalAuth } from '../../middleware/auth.js';
import { getAgentCapabilities } from '../../lib/agent/health.js';
import { getDb } from '../../db/index.js';
import {
  createAgent,
  deleteAgentOwnedBy,
  findAgentByHandle,
  findAgentById,
  findAgentKnowledge,
  findAgentSkills,
  listAgentCatalogue,
  listAgentsByAuthor,
  updateAgent,
  type AgentRecord,
} from '../../db/agents/agentRepository.js';
import {
  createTrigger,
  findAgentTriggerByType,
  updateTrigger,
} from '../../db/automation/triggerRepository.js';
import { TRIGGER_SCHEDULE_TYPES, type TriggerScheduleType } from '../../db/schema/automation.js';
import { reloadTrigger, generateWebhookToken } from '../../lib/trigger-engine.js';
import {
  AGENT_ARCHETYPES,
  AGENT_STATUSES,
  readArchetypeConfig,
  type AgentArchetype,
  type AgentStatus,
} from '../../domain/agent.js';
import { log } from '../../lib/logger.js';
import { storedMediaUrl } from '../../lib/stored-media.js';
import type { Request, Response } from 'express';

const router = Router();

/**
 * A stored `archetype_config.schedule.type` the trigger schema accepts.
 *
 * `archetype_config` is `jsonb` with nothing validating it, while
 * `triggers.schedule_type` carries a CHECK — so an unrecognised value falls back
 * to `daily` rather than becoming a refused write deep inside a fire-and-forget
 * sync nobody is awaiting.
 */
function isTriggerScheduleType(value: unknown): value is TriggerScheduleType {
  return typeof value === 'string' && (TRIGGER_SCHEDULE_TYPES as readonly string[]).includes(value);
}

// ── Archetype Trigger Sync ──────────────────────────────────────────

/**
 * Sync triggers for archetype agents:
 * - status_update: auto-create/update schedule trigger
 * - task_router: auto-create webhook trigger if 'webhook' channel configured
 */
async function syncArchetypeTriggers(
  agentId: string,
  userId: string,
  agent: Pick<AgentRecord, 'archetype' | 'archetypeConfig' | 'name'>,
): Promise<void> {
  const config = readArchetypeConfig(agent.archetypeConfig);

  if (agent.archetype === 'status_update' && config.schedule) {
    const existing = await findAgentTriggerByType(getDb(), userId, agentId, 'schedule');

    const triggerSchedule = {
      // A stored `schedule.type` outside the trigger schema's closed set falls
      // back to `daily` rather than becoming a refused write deep inside a
      // fire-and-forget sync nobody is awaiting.
      type: isTriggerScheduleType(config.schedule.type) ? config.schedule.type : 'daily',
      ...(config.schedule.time && { time: config.schedule.time }),
      ...(config.schedule.days && { days: config.schedule.days }),
      ...(config.schedule.intervalMinutes && { intervalMinutes: config.schedule.intervalMinutes }),
      ...(config.schedule.cron && { cron: config.schedule.cron }),
    };

    const reportPrompt = config.reportTemplate
      ? `Generate a status report following this template:\n\n${config.reportTemplate}`
      : 'Generate a comprehensive status update report from all configured data sources.';

    if (existing) {
      // `schedule` REPLACES and `action` MERGES, exactly as the hydrated-document
      // path did: `set('schedule', …)` overwrote the sub-document while the
      // prompt was assigned field by field.
      await updateTrigger(getDb(), existing._id, {
        schedule: triggerSchedule,
        action: { prompt: reportPrompt },
        name: `${agent.name || 'Agent'} Report`,
      });
      await reloadTrigger(existing._id);
    } else {
      const trigger = await createTrigger(getDb(), {
        oxyUserId: userId,
        name: `${agent.name || 'Agent'} Report`,
        description: `Scheduled status report from ${agent.name || 'agent'}`,
        type: 'schedule',
        enabled: true,
        action: {
          prompt: reportPrompt,
          agentId,
          useTools: true,
          notify: true,
          ...(config.deliveryChannels?.[0] && { channelId: config.deliveryChannels[0] }),
        },
        schedule: triggerSchedule,
        triggerCount: 0,
      });
      await reloadTrigger(trigger._id);
    }
  }

  if (agent.archetype === 'task_router' && config.inboundChannels?.includes('webhook')) {
    const existing = await findAgentTriggerByType(getDb(), userId, agentId, 'webhook');

    if (!existing) {
      await createTrigger(getDb(), {
        oxyUserId: userId,
        name: `${agent.name || 'Agent'} Webhook`,
        description: `Inbound webhook for task routing by ${agent.name || 'agent'}`,
        type: 'webhook',
        enabled: true,
        action: {
          prompt: 'Process and route this incoming task.',
          agentId,
          useTools: true,
          notify: true,
        },
        webhook: {
          token: generateWebhookToken(),
        },
        triggerCount: 0,
      });
    }
  }
}

/** The agent's own record plus the two child lists `populate` used to attach. */
async function withChildLists(agent: AgentRecord): Promise<AgentRecord> {
  const [skills, knowledge] = await Promise.all([
    findAgentSkills(getDb(), agent._id),
    findAgentKnowledge(getDb(), agent._id),
  ]);
  return { ...agent, skills, knowledge };
}

/** A `string[]` of ids from a request body, or nothing. */
function idList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

// GET /agents - list published agents (public, optional auth)
/**
 * An agent, with its avatar addressable.
 *
 * `avatar` is polymorphic on purpose: an owner may paste any URL, and the
 * avatar generator stores an object here and records its KEY. A value that
 * already carries a scheme is somebody else's address and is passed through
 * untouched; one that does not is ours, and only ours becomes a link.
 *
 * That check is the honest discriminator rather than a guess — a stored key
 * never has a scheme, because it is a path inside a bucket.
 */
function withAddressableAvatar<T extends { avatar?: string | null }>(
  req: Request,
  userId: string | undefined,
  agent: T,
): T {
  const avatar = agent.avatar;
  if (avatar === null || avatar === undefined || avatar === '') return agent;
  if (/^[a-z][a-z0-9+.-]*:/i.test(avatar)) return agent;
  if (userId === undefined) {
    // No one to mint a link for. The field is dropped rather than emitted as a
    // key, which a browser would request against its own origin.
    const { avatar: _stored, ...rest } = agent;
    return rest as T;
  }
  const link = storedMediaUrl(req, avatar, userId);
  if (link !== null) return { ...agent, avatar: link };
  const { avatar: _unservable, ...rest } = agent;
  return rest as T;
}

router.get('/', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { category, search, featured, trending, page = '1', limit = '50' } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 50));

    const { agents, total } = await listAgentCatalogue(getDb(), {
      ...(typeof category === 'string' && { category }),
      ...(typeof req.query.archetype === 'string' && { archetype: req.query.archetype }),
      featured: featured === 'true',
      trending: trending === 'true',
      ...(typeof search === 'string' && search !== '' && { search }),
      limit: limitNum,
      offset: (pageNum - 1) * limitNum,
    });

    res.json({ agents: agents.map((agent) => withAddressableAvatar(req, req.user?.id, agent)), total, page: pageNum, limit: limitNum });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error listing agents');
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

// GET /agents/me - list current user's agents (must be before /:id)
router.get('/me', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const owned = await listAgentsByAuthor(getDb(), req.user.id);
    const agents = await Promise.all(owned.map(withChildLists));

    res.json({ agents: agents.map((agent) => withAddressableAvatar(req, req.user?.id, agent)) });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error listing user agents');
    res.status(500).json({ error: 'Failed to list your agents' });
  }
});

// GET /agents/health - infrastructure status
router.get('/health', async (_req: Request, res: Response) => {
  try {
    const capabilities = await getAgentCapabilities();
    res.json({ capabilities });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error checking agent health');
    res.status(500).json({ error: 'Failed to check health' });
  }
});

// GET /agents/:id - get single agent (public)
router.get('/:id', optionalAuth, async (req: Request, res: Response) => {
  try {
    const found = await findAgentById(getDb(), String(req.params.id));

    if (!found) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Allow owner to view unpublished (draft) agents
    if (!found.isPublished && (!req.user?.id || found.author !== req.user.id)) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({ agent: withAddressableAvatar(req, req.user?.id, await withChildLists(found)) });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error getting agent');
    res.status(500).json({ error: 'Failed to get agent' });
  }
});

// POST /agents - create agent
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      name, handle, avatar,
      tagline, description, category, tags, price,
      capabilities, skills, knowledge,
      isPublished, creditBalance, allowHiring,
      systemPrompt, archetype, archetypeConfig,
    } = req.body;

    if (!name || !handle || !tagline || !description || !category) {
      return res.status(400).json({
        error: 'name, handle, tagline, description, and category are required',
      });
    }

    const existing = await findAgentByHandle(getDb(), handle);
    if (existing) {
      return res.status(409).json({ error: 'Handle already taken' });
    }

    const agent = await createAgent(getDb(), {
      name,
      handle,
      avatar: avatar || null,
      tagline,
      description,
      authorOxyUserId: req.user.id,
      authorName: req.user.username || 'Unknown',
      category,
      tags: idList(tags) ?? [],
      price: price ?? null,
      capabilities: idList(capabilities) ?? [],
      skillIds: idList(skills) ?? [],
      libraryFileIds: idList(knowledge) ?? [],
      isPublished: isPublished ?? true,
      creditBalance: creditBalance ?? 0,
      allowHiring: allowHiring ?? false,
      ...(systemPrompt && { systemPrompt }),
      ...(isAgentArchetype(archetype) && { archetype }),
      ...(archetypeConfig && { archetypeConfig }),
    });

    res.status(201).json({ agent });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error creating agent');
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

function isAgentArchetype(value: unknown): value is AgentArchetype {
  return typeof value === 'string' && (AGENT_ARCHETYPES as readonly string[]).includes(value);
}

function isAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === 'string' && (AGENT_STATUSES as readonly string[]).includes(value);
}

// PATCH /agents/:id - update agent (owner only)
router.patch('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const id = String(req.params.id);
    const body: Record<string, unknown> = req.body;

    /**
     * The allow-list, field by field, and NOT a loop over `req.body`.
     *
     * The hydrated path assigned every allowed field with `agent.set(field,
     * value)`, so the schema was the only thing deciding what a value could be —
     * and `status` and `archetype` are CHECK-constrained columns now, where an
     * unexpected string is a refused write rather than a stored one. Naming each
     * field is also what keeps `author` and `handle` unreachable: neither is in
     * the list, and a spread of `req.body` would put both back.
     */
    const patch = {
      ...(typeof body.name === 'string' && { name: body.name }),
      ...(body.avatar !== undefined && {
        avatar: typeof body.avatar === 'string' ? body.avatar : null,
      }),
      ...(typeof body.tagline === 'string' && { tagline: body.tagline }),
      ...(typeof body.description === 'string' && { description: body.description }),
      ...(typeof body.category === 'string' && { category: body.category }),
      ...(idList(body.tags) !== undefined && { tags: idList(body.tags) }),
      ...(body.price !== undefined && {
        price: typeof body.price === 'number' ? body.price : null,
      }),
      ...(idList(body.capabilities) !== undefined && { capabilities: idList(body.capabilities) }),
      ...(typeof body.isPublished === 'boolean' && { isPublished: body.isPublished }),
      ...(isAgentStatus(body.status) && { status: body.status }),
      ...(typeof body.creditBalance === 'number' && { creditBalance: body.creditBalance }),
      ...(typeof body.allowHiring === 'boolean' && { allowHiring: body.allowHiring }),
      ...(typeof body.systemPrompt === 'string' && { systemPrompt: body.systemPrompt }),
      ...(idList(body.allowedModels) !== undefined && {
        allowedModels: idList(body.allowedModels),
      }),
      ...(typeof body.scheduleInterval === 'number' && {
        scheduleInterval: body.scheduleInterval,
      }),
      ...(isAgentArchetype(body.archetype) && { archetype: body.archetype }),
      ...(body.archetypeConfig !== undefined && { archetypeConfig: body.archetypeConfig }),
      ...(idList(body.skills) !== undefined && { skillIds: idList(body.skills) }),
      ...(idList(body.knowledge) !== undefined && { libraryFileIds: idList(body.knowledge) }),
    };

    const agent = await updateAgent(getDb(), id, req.user.id, patch);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Auto-manage linked triggers for archetype agents (non-blocking, only when relevant fields change)
    if (body.archetype !== undefined || body.archetypeConfig !== undefined || body.scheduleInterval !== undefined || body.status !== undefined) {
      syncArchetypeTriggers(agent._id, agent.author, agent).catch(err => {
        log.agents.error({ err, agentId: agent._id }, 'Failed to sync archetype triggers');
      });
    }

    res.json({ agent: withAddressableAvatar(req, req.user?.id, agent) });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error updating agent');
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

// DELETE /agents/:id - delete agent (owner only)
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const deleted = await deleteAgentOwnedBy(getDb(), String(req.params.id), req.user.id);

    if (deleted === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({ success: true });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error deleting agent');
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

export default router;
