/**
 * What an agent hears about, and what it has been told (ADR 0026).
 *
 * Owner-facing: the caller must be able to act as the agent's bot account (`loadAgentForActor`, checked
 * with Oxy on every request). An agent can subscribe to the events of exactly two accounts — its owner's
 * (only when the caller IS the owner) and its own mailbox — so a subscription can never read another
 * person's events.
 */

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import {
  MAX_SUBSCRIPTIONS_PER_AGENT,
  countAgentSubscriptions,
  deleteAgentSubscription,
  listAgentSubscriptions,
  listInboxItems,
  upsertAgentSubscription,
} from '../../db/agents/agentInboxRepository.js';
import { getDb } from '../../db/index.js';
import { loadAgentForActor, refusalMessage, refusalStatus } from '../../lib/agent-account.js';
import { log } from '../../lib/logger.js';
import { authenticateToken } from '../../middleware/auth.js';

const router = Router();

const NAME = /^(\*|[a-z0-9][a-z0-9._-]{0,63})$/;
const subscribeSchema = z
  .object({
    appId: z.string().regex(NAME),
    eventType: z.string().regex(NAME),
    /** Whose events: the owner's own, or this agent's mailbox. */
    account: z.enum(['owner', 'agent']),
  })
  .strict();

async function agentForOwnerSurface(req: Request, res: Response) {
  if (!req.user?.id || !req.accessToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const loaded = await loadAgentForActor(getDb(), {
    agentId: String(req.params.id),
    oxyUserId: req.user.id,
    accessToken: req.accessToken,
    cache: false,
  });
  if (!loaded.ok) {
    res.status(loaded.refusal === 'agent_not_found' ? 404 : refusalStatus(loaded.refusal)).json({
      error:
        loaded.refusal === 'agent_not_found' ? 'Agent not found' : refusalMessage(loaded.refusal),
    });
    return null;
  }
  return loaded.agent;
}

router.get('/:id/subscriptions', authenticateToken, async (req: Request, res: Response) => {
  try {
    const agent = await agentForOwnerSurface(req, res);
    if (!agent) return;
    res.json({ subscriptions: await listAgentSubscriptions(getDb(), agent._id) });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Could not list agent subscriptions');
    res.status(500).json({ error: 'Could not list subscriptions' });
  }
});

router.post('/:id/subscriptions', authenticateToken, async (req: Request, res: Response) => {
  try {
    const agent = await agentForOwnerSurface(req, res);
    if (!agent || !req.user?.id) return;
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid subscription', details: z.flattenError(parsed.error) });
    }
    if (agent.ownerOxyAccountId === null) {
      return res.status(409).json({ error: 'This agent has no owner to wake it for' });
    }
    if (parsed.data.account === 'owner' && req.user.id !== agent.ownerOxyAccountId) {
      // An operator may manage the agent, but its owner's events are the owner's to share.
      return res
        .status(403)
        .json({ error: 'Only the owner can subscribe an agent to their events' });
    }
    if ((await countAgentSubscriptions(getDb(), agent._id)) >= MAX_SUBSCRIPTIONS_PER_AGENT) {
      return res
        .status(409)
        .json({ error: `An agent can have at most ${MAX_SUBSCRIPTIONS_PER_AGENT} subscriptions` });
    }
    const subscription = await upsertAgentSubscription(getDb(), {
      agentId: agent._id,
      ownerAccountId: agent.ownerOxyAccountId,
      sourceAccountId:
        parsed.data.account === 'owner' ? agent.ownerOxyAccountId : agent.oxyAccountId,
      appId: parsed.data.appId,
      eventType: parsed.data.eventType,
    });
    res.status(201).json({ subscription });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Could not subscribe an agent');
    res.status(500).json({ error: 'Could not subscribe' });
  }
});

router.delete(
  '/:id/subscriptions/:subscriptionId',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const agent = await agentForOwnerSurface(req, res);
      if (!agent) return;
      const removed = await deleteAgentSubscription(
        getDb(),
        agent._id,
        String(req.params.subscriptionId),
      );
      if (!removed) return res.status(404).json({ error: 'Subscription not found' });
      res.status(204).end();
    } catch (error: unknown) {
      log.agents.error({ err: error }, 'Could not remove an agent subscription');
      res.status(500).json({ error: 'Could not remove the subscription' });
    }
  },
);

router.get('/:id/inbox', authenticateToken, async (req: Request, res: Response) => {
  try {
    const agent = await agentForOwnerSurface(req, res);
    if (!agent) return;
    const status = z.enum(['pending', 'delivered', 'dismissed']).safeParse(req.query.status);
    const items = await listInboxItems(
      getDb(),
      agent._id,
      status.success ? { status: status.data } : {},
    );
    res.json({ items });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Could not list an agent inbox');
    res.status(500).json({ error: 'Could not list the inbox' });
  }
});

export default router;
