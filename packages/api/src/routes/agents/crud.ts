import { Router } from 'express';
import { authenticateToken, optionalAuth } from '../../middleware/auth.js';
import { getAgentCapabilities } from '../../lib/agent/health.js';
import { getDb } from '../../db/index.js';
import {
  createAgent,
  deleteAgent,
  findAgentById,
  withoutInternalAgentBindings,
  withoutSystemPrompt,
  findAgentKnowledge,
  findAgentSkills,
  listAgentCatalogue,
  listActiveAgentsByAuthor,
  listAgentsByAuthor,
  updateAgent,
  type AgentRecord,
} from '../../db/agents/agentRepository.js';
import {
  loadAgentForActor,
  refusalMessage,
  refusalStatus,
  verifyAgentAccount,
  type AgentAccountRefusal,
} from '../../lib/agent-account.js';
import {
  agentPromptName,
  attachAgentIdentities,
  attachAgentIdentity,
  resolveAgentIdentities,
  UNRESOLVED_IDENTITY,
} from '../../lib/agent-identity.js';
import { latestMessagePerAgent } from '../../db/chat/conversationRepository.js';
import {
  createTrigger,
  findAgentTriggerByType,
  updateTrigger,
} from '../../db/automation/triggerRepository.js';
import { TRIGGER_SCHEDULE_TYPES, type TriggerScheduleType } from '../../db/schema/automation.js';
import { reloadTrigger, generateWebhookToken } from '../../lib/trigger-engine.js';
import {
  AGENT_ACCESS,
  AGENT_ARCHETYPES,
  AGENT_STATUSES,
  readArchetypeConfig,
  type AgentAccess,
  type AgentArchetype,
  type AgentStatus,
} from '../../domain/agent.js';
import { log } from '../../lib/logger.js';
import { z } from 'zod';
import { isNativeProductAgentId } from '../../config/native-product-agents.js';
import { OXY_KAANA_ROUTING_PROFILE_IDS } from '../../config/oxy-inference-routing-profile-ids.js';
import { formatCapabilityGrant, isCapabilityGrant } from '../../domain/capability-grants.js';
import {
  listMcpServersForUser,
  type McpServerRow,
} from '../../db/integrations/mcpServerRepository.js';
import {
  listIntegrationsForUser,
  type IntegrationSafeRow,
} from '../../db/integrations/integrationRepository.js';
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
  agent: Pick<AgentRecord, 'archetype' | 'archetypeConfig'> & { name: string | null },
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

/** The refusal shape every write path here answers with. */
function answerRefusal(res: Response, refusal: AgentAccountRefusal | 'agent_not_found'): Response {
  if (refusal === 'agent_not_found') return res.status(404).json({ error: 'Agent not found' });
  return res.status(refusalStatus(refusal)).json({ error: refusalMessage(refusal) });
}

// GET /agents - list published agents (public, optional auth)
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

    res.json({
      agents: await attachAgentIdentities(agents.map(withoutInternalAgentBindings)),
      total,
      page: pageNum,
      limit: limitNum,
    });
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

    /*
     * The ORDER is the repository's, and every step below preserves it: the
     * sidebar draws this array as it arrives, so `listAgentsByAuthor` deciding
     * that the agent last spoken to comes first only holds if nothing here
     * re-sorts or re-groups. Both hydration steps are `map`s over the same
     * array for that reason.
     */
    const owned = await listAgentsByAuthor(getDb(), req.user.id);

    /*
     * The newest line of each thread, so the sidebar can read like a list of
     * chats rather than a list of names. ONE query for the whole list — asking
     * per agent would be a query per row, which is the shape this exists to
     * avoid — and scoped to the caller, because the line belongs to their own
     * thread with the agent and not to the agent's busiest stranger.
     *
     * It needs only `owned`, so it runs BESIDE hydration rather than after it.
     * Awaited in sequence it sat behind `attachAgentIdentities`, which is an
     * HTTP call to Oxy: a database round trip queued behind a network one, on
     * every sidebar load.
     */
    const [identified, latest] = await Promise.all([
      Promise.all(owned.map(withChildLists)).then(attachAgentIdentities),
      latestMessagePerAgent(
        getDb(),
        req.user.id,
        owned.map((agent) => agent._id),
      ),
    ]);
    const byAgent = new Map(latest.map((row) => [row.agentId, row]));

    res.json({
      agents: identified.map((agent) => {
        const thread = byAgent.get(agent._id);
        return {
          ...withoutInternalAgentBindings(agent),
          // `null` rather than absent: an agent with no thread yet is the
          // ordinary case — you have just made it — and the client renders that
          // as its own line rather than as a gap.
          lastMessage: thread?.lastMessage ?? null,
          lastMessageAt: thread?.updatedAt.toISOString() ?? null,
        };
      }),
    });
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

/**
 * GET /agents/capability-connectors — the ROWS this caller can grant an agent.
 *
 * Three capability families are granted one row at a time
 * (`mcp:<id>`, `integration:<service>`, `agent:<id>`),
 * because nobody can enumerate their members in advance. A screen offering
 * those grants has to know which rows exist, and only this service knows all
 * three. Oxy app/resource delegation is deliberately absent: it is edited in
 * Oxy Settings and stored in Oxy's normalized DelegationGrant records.
 *
 * `?agent=<id>` is the agent being EDITED, left out of its own list. Cosmetic
 * only — the assembler excludes the calling agent whatever is stored — but an
 * inert switch that grants an agent a conversation with itself is worse than no
 * switch.
 *
 * The `grant` STRING is built here rather than in the client. It is the value
 * that goes into `capability_grants` verbatim, so a client that assembled it
 * from a family and an id would be a second place the separator is written —
 * and `family:instanceId` disagreeing across the seam is silent in both
 * directions: an unrecognised grant is refused on write and dropped on read.
 *
 * Every source FAILS OPEN and independently. A connector service being down
 * costs its own section, not the whole screen — the same reasoning the tool
 * pipeline's `bulkFailure` gives one layer down.
 */
router.get('/capability-connectors', authenticateToken, async (req: Request, res: Response) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const oxyUserId = req.user.id;

  const excludeAgentId = typeof req.query.agent === 'string' ? req.query.agent : undefined;
  const [mcp, integration, ownAgents] = await Promise.all([
    listMcpServersForUser(getDb(), oxyUserId).catch(connectorFailure<McpServerRow>('mcp')),
    listIntegrationsForUser(getDb(), oxyUserId).catch(connectorFailure<IntegrationSafeRow>('integration')),
    grantableAgentRows(oxyUserId, excludeAgentId).catch(connectorFailure<GrantableConnectorRow>('agent')),
  ]);

  res.json({
    connectors: [
      ...ownAgents,
      ...mcp.map((server) => ({
        grant: formatCapabilityGrant('mcp', server.id),
        family: 'mcp',
        label: server.displayName,
        // What the agent would actually gain. A connector with no tools grants
        // nothing, and saying so is better than an inert toggle.
        detail: `${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}`,
      })),
      ...integration.map((row) => ({
        // The SERVICE, not the row id: `buildIntegrationTools` matches on
        // `google-calendar` / `google-drive`, which is what
        // `listConnectedServices` answers, so a grant naming the row's own id
        // would match nothing and fail silently.
        grant: formatCapabilityGrant('integration', row.service),
        family: 'integration',
        label: row.displayName,
        detail: row.status === 'active' ? 'Connected' : row.status,
      })),
    ],
  });
});

/** One grantable row, exactly as the agent editor renders it. */
interface GrantableConnectorRow {
  grant: string;
  family: string;
  label: string;
  detail: string;
}

/**
 * The caller's own active agents, plus the ONE row that means all of them.
 *
 * The bare `agent` grant is a real grant string and is assembled here like
 * every other, so the client still never writes the separator — or its absence.
 * It is offered only when there is at least one agent to reach, because a
 * switch labelled "all of them" over none is a promise about an empty set.
 *
 * Names come from Oxy in one batch and FAIL OPEN: an account that does not
 * resolve keeps its row under the generic name, since the tagline beside it is
 * Alia's own and still says which agent this is.
 */
async function grantableAgentRows(
  oxyUserId: string,
  excludeAgentId: string | undefined,
): Promise<GrantableConnectorRow[]> {
  const owned = (await listActiveAgentsByAuthor(getDb(), oxyUserId)).filter(
    (agent) => agent._id !== excludeAgentId,
  );
  if (owned.length === 0) return [];

  const identities = await resolveAgentIdentities(owned.map((agent) => agent.oxyAccountId));
  return [
    {
      grant: formatCapabilityGrant('agent'),
      family: 'agent',
      label: 'All your active agents',
      detail: 'New agents join automatically; switching one off removes it',
    },
    ...owned.map((agent) => ({
      grant: formatCapabilityGrant('agent', agent._id),
      family: 'agent',
      label: agentPromptName(identities.get(agent.oxyAccountId) ?? UNRESOLVED_IDENTITY),
      detail: agent.tagline,
    })),
  ];
}

/** A connector source that could not be listed contributes nothing, loudly. */
function connectorFailure<T>(family: string): (err: unknown) => T[] {
  return (err: unknown) => {
    log.agents.warn({ err, family }, 'Could not list grantable connectors for a family');
    return [];
  };
}

/**
 * GET /agents/:id — the agent's card, and its prompt only for whoever may edit
 * it.
 *
 * ## The prompt does not leave here for anybody else
 *
 * This route is `optionalAuth`, `findAgentById` selects every column and
 * `toAgentRecord` carries `system_prompt`, so a published agent's instructions
 * were served to anyone who asked — unauthenticated. Anybody could copy an
 * agent by reading its card. The catalogue had always withheld it; the single
 * agent had not, which is the shape that reads as closed without being.
 *
 * Who may see it is who may EDIT it — `account:act_as` on the bot account,
 * which is the same question `PATCH /agents/:id` asks, so the editor loads what
 * it saves. Deliberately NOT everyone who may USE it: an agent shared with you
 * is one you can run, and running it is not copying it.
 *
 * A draft stays owner-only, now asked as act-as rather than as
 * `author === caller`: an agent under an organization is administered by people
 * the column does not name, and the column is a listing index rather than a
 * gate — `db/schema/agents.ts` says so where it is declared.
 */
router.get('/:id', optionalAuth, async (req: Request, res: Response) => {
  try {
    const found = await findAgentById(getDb(), String(req.params.id));

    if (!found) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const mayEdit = req.user?.id === undefined || req.accessToken === undefined
      ? false
      : (await verifyAgentAccount({
          oxyUserId: req.user.id,
          accessToken: req.accessToken,
          oxyAccountId: found.oxyAccountId,
          // A READ. The write paths pass `false`; see `lib/agent-account.ts`.
          cache: true,
        })).permitted;

    // A draft is not in the catalogue and not addressable by a stranger.
    if (!found.isPublished && !mayEdit) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const agent = await withChildLists(found);
    res.json({
      agent: await attachAgentIdentity(
        withoutInternalAgentBindings(mayEdit ? agent : withoutSystemPrompt(agent)),
      ),
    });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error getting agent');
    res.status(500).json({ error: 'Failed to get agent' });
  }
});

/**
 * The archetypes and statuses, as Zod enums built from the domain lists.
 *
 * Rebuilt here rather than restated: `AGENT_ARCHETYPES` and `AGENT_STATUSES`
 * are the same arrays the CHECK constraints derive from, so a value this
 * accepts is a value the column accepts, and adding an archetype cannot leave
 * the wire schema behind.
 */
const archetypeSchema = z.enum(AGENT_ARCHETYPES as unknown as [AgentArchetype, ...AgentArchetype[]]);
const statusSchema = z.enum(AGENT_STATUSES as unknown as [AgentStatus, ...AgentStatus[]]);
const accessSchema = z.enum(AGENT_ACCESS as unknown as [AgentAccess, ...AgentAccess[]]);

/**
 * One capability grant: `family`, or `family:instanceId` for the three families
 * whose members are rows.
 *
 * REFUSED here rather than dropped, which is the difference between this and
 * `readCapabilityGrants`. The reader runs at request time on a value already in
 * the database, where the only useful answer is to ignore what it cannot parse.
 * This runs while somebody is still on the other end of the connection and can
 * be told the grant was not written — the failure mode the three vocabularies
 * this replaces all had, in different ways.
 */
const capabilityGrantSchema = z
  .string()
  .refine(isCapabilityGrant, { message: 'Not a capability grant' });

/**
 * What `POST /agents` accepts.
 *
 * `oxyAccountId` is REQUIRED and is the only identity field on the whole
 * request: `name`, `handle`, `avatar` and `authorName` used to be here and are
 * Oxy's now. Sending one is a 400 rather than a silent drop — `strict()` —
 * because a client still writing `name` believes it is setting the agent's
 * name, and quietly ignoring it would leave the agent called something else
 * with nothing to say why.
 *
 * The predecessor was a hand-rolled type-guard prelude plus a 28-line block of
 * conditional spreads. Both are gone.
 *
 * THIS is now the reference for the agents domain, and it inherited the role
 * rather than invented it: the pattern came from `routes/agent-teams.ts`, which
 * was deleted with the teams feature. That router was the only one in the domain
 * that validated with a schema — its four siblings each hand-rolled something
 * different — so the one good example was about to leave with a feature nobody
 * used. It is reproduced here instead: a `z.object(...).strict()`, `.parse()`d
 * once at the top of the handler with the parsed value used from then on, and a
 * `z.ZodError` branch in the catch that turns anything the schema does not name
 * into a 400 with the field errors attached.
 */
const createAgentSchema = z
  .object({
    oxyAccountId: z.string().min(1),
    tagline: z.string().min(1).max(200),
    description: z.string().min(1).max(5000),
    category: z.string().min(1).max(100),
    tags: z.array(z.string()).optional(),
    price: z.number().int().nullable().optional(),
    capabilityGrants: z.array(capabilityGrantSchema).optional(),
    skills: z.array(z.string()).optional(),
    knowledge: z.array(z.string()).optional(),
    isPublished: z.boolean().optional(),
    access: accessSchema.optional(),
    systemPrompt: z.string().optional(),
    archetype: archetypeSchema.optional(),
    archetypeConfig: z.unknown().optional(),
  })
  .strict();

// POST /agents - create agent
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id || req.accessToken === undefined) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const data = createAgentSchema.parse(req.body);

    /**
     * The account is verified BEFORE the row is written, and all three
     * questions are one call: does it exist, is it a `bot`, and may this caller
     * act as it. Writing first and checking after would leave an agent bound to
     * somebody else's account on any failure between the two.
     */
    const verdict = await verifyAgentAccount({
      oxyUserId: req.user.id,
      accessToken: req.accessToken,
      oxyAccountId: data.oxyAccountId,
      // A WRITE. Never a cached verdict — see `lib/agent-account.ts`.
      cache: false,
    });
    if (!verdict.permitted) return answerRefusal(res, verdict.refusal);

    const agent = await createAgent(getDb(), {
      oxyAccountId: data.oxyAccountId,
      ownerOxyAccountId: verdict.ownerAccountId,
      tagline: data.tagline,
      description: data.description,
      authorOxyUserId: req.user.id,
      category: data.category,
      routingProfileId: OXY_KAANA_ROUTING_PROFILE_IDS['kaana-v1'],
      tags: data.tags ?? [],
      price: data.price ?? null,
      capabilityGrants: data.capabilityGrants ?? [],
      skillIds: data.skills ?? [],
      libraryFileIds: data.knowledge ?? [],
      /**
       * Published by default and PRIVATE by default, which is one decision
       * about two questions: it appears in the catalogue, and using it takes
       * the owner's say-so. Before these were one flag, "listed" and "anyone
       * may run it" could not be told apart.
       */
      isPublished: data.isPublished ?? true,
      access: data.access ?? 'private',
      ...(data.systemPrompt !== undefined && { systemPrompt: data.systemPrompt }),
      ...(data.archetype !== undefined && { archetype: data.archetype }),
      ...(data.archetypeConfig !== undefined && { archetypeConfig: data.archetypeConfig }),
    });

    res.status(201).json({
      agent: await attachAgentIdentity(withoutInternalAgentBindings(agent)),
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.agents.error({ err: error }, 'Error creating agent');
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

/**
 * What `PATCH /agents/:id` accepts.
 *
 * No `name`, no `avatar`, no `creditBalance`. The first two are the bot
 * account's and are edited through Oxy; the third named a column nothing ever
 * spent. `oxyAccountId` is absent too — rebinding an agent to a different
 * account is not an edit, it is a different agent.
 *
 * Every member is optional and `undefined` never reaches the repository, which
 * builds its SET clause from DEFINED keys only: `{ x: undefined }` is a no-op
 * in Mongo and a NULL write in Postgres.
 */
const updateAgentSchema = z
  .object({
    tagline: z.string().min(1).max(200).optional(),
    description: z.string().min(1).max(5000).optional(),
    category: z.string().min(1).max(100).optional(),
    tags: z.array(z.string()).optional(),
    price: z.number().int().nullable().optional(),
    capabilityGrants: z.array(capabilityGrantSchema).optional(),
    isPublished: z.boolean().optional(),
    status: statusSchema.optional(),
    access: accessSchema.optional(),
    systemPrompt: z.string().optional(),
    scheduleInterval: z.number().int().optional(),
    archetype: archetypeSchema.optional(),
    archetypeConfig: z.unknown().optional(),
    skills: z.array(z.string()).optional(),
    knowledge: z.array(z.string()).optional(),
  })
  .strict();

// PATCH /agents/:id - update agent (anyone who may act as the bot account)
router.patch('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id || req.accessToken === undefined) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const id = String(req.params.id);
    const data = updateAgentSchema.parse(req.body);

    const loaded = await loadAgentForActor(getDb(), {
      agentId: id,
      oxyUserId: req.user.id,
      accessToken: req.accessToken,
      // A WRITE. Never a cached verdict — see `lib/agent-account.ts`.
      cache: false,
    });
    if (!loaded.ok) return answerRefusal(res, loaded.refusal);

    if (
      (typeof loaded.agent.applicationId === 'string' || isNativeProductAgentId(id))
      && (
        data.systemPrompt !== undefined
        || data.capabilityGrants !== undefined
        || data.access !== undefined
        || data.isPublished !== undefined
        || data.status !== undefined
      )
    ) {
      return res.status(400).json({ error: 'Product-agent policy is managed internally' });
    }

    const { skills, knowledge, ...columns } = data;
    const agent = await updateAgent(getDb(), id, {
      ...columns,
      ...(skills !== undefined && { skillIds: skills }),
      ...(knowledge !== undefined && { libraryFileIds: knowledge }),
    });

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    /**
     * The SAME shape `GET /agents/:id` answers with — child lists attached.
     *
     * They were not, and `useUpdateAgent` writes this answer straight into the
     * `agents.detail` cache, so a save replaced the agent the editor was holding
     * with one that had no `skills` and no `knowledge`. The screen re-seeded
     * from it, and its next autosave sent `skills: []` — which DELETES them.
     * Two routes serving one resource in two shapes is the bug; the client can
     * only ever paper over it.
     */
    const hydrated = await attachAgentIdentity(await withChildLists(agent));

    // Auto-manage linked triggers for archetype agents (non-blocking, only when relevant fields change)
    if (
      data.archetype !== undefined ||
      data.archetypeConfig !== undefined ||
      data.scheduleInterval !== undefined ||
      data.status !== undefined
    ) {
      syncArchetypeTriggers(hydrated._id, hydrated.author, hydrated).catch((err) => {
        log.agents.error({ err, agentId: hydrated._id }, 'Failed to sync archetype triggers');
      });
    }

    res.json({ agent: withoutInternalAgentBindings(hydrated) });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.agents.error({ err: error }, 'Error updating agent');
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

// DELETE /agents/:id - delete agent (anyone who may act as the bot account)
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id || req.accessToken === undefined) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const id = String(req.params.id);
    const loaded = await loadAgentForActor(getDb(), {
      agentId: id,
      oxyUserId: req.user.id,
      accessToken: req.accessToken,
      // A WRITE. Never a cached verdict — see `lib/agent-account.ts`.
      cache: false,
    });
    if (!loaded.ok) return answerRefusal(res, loaded.refusal);

    if (isNativeProductAgentId(id) || typeof loaded.agent.applicationId === 'string') {
      return res.status(400).json({ error: 'Product-agent policy is managed internally' });
    }

    /**
     * The Oxy `bot` account SURVIVES the agent, and that is the deliberate
     * choice. Alia owns the runtime, not the identity: archiving somebody's
     * account because a row in another service was deleted is a power this
     * service does not have, and the account may hold posts, a follower graph
     * and a credit balance of its own. The owner archives it from Oxy.
     */
    const deleted = await deleteAgent(getDb(), id);
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
