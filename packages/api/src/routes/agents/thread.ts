/**
 * `GET /agents/thread/:username` — the permanent thread between a person and an
 * agent, resolved or created.
 *
 * This is what `/a/pepe` calls when the screen opens. One request answers both
 * halves the screen needs: who the agent IS, so the header can draw its name
 * and colour without a second round trip, and WHICH conversation to load, so
 * the existing conversation screen takes over from there.
 *
 * ## Every refusal is 404, and a 403 would be a leak
 *
 * A stranger who guesses a handle must not be able to tell an unpublished
 * agent from a handle nobody has taken. A 403 answers that question: it says
 * the agent exists and you may not have it. So the route has exactly two
 * outcomes — the thread, or "no such thread" — and `loadThreadAgent` collapses
 * the four ways of not reaching an agent (no such username, a username that is
 * a person, a draft belonging to somebody else, Oxy unreachable) into one null.
 *
 * The cost is real and accepted: an owner whose Oxy is down is told their own
 * agent does not exist, rather than that identity is unavailable. Every other
 * agent route can afford to distinguish those because it is already addressing
 * an agent by an id the caller had to have been given; this one is addressed by
 * a GUESSABLE handle, which is the whole difference.
 *
 * ## The thread is per PAIR, not per agent
 *
 * Two people talking to the same agent hold two threads and see two histories.
 * `resolveAgentThread` scopes on `(oxy_user_id, agent_id)` and
 * `conversations_oxy_user_agent_id_key` enforces one row per pair — the failure
 * this shape exists to prevent is a lookup by `agent_id` alone, which would
 * show one person another person's conversation.
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/index.js';
import { resolveAgentThread } from '../../db/chat/conversationRepository.js';
import { agentPromptName } from '../../lib/agent-identity.js';
import { loadThreadAgent } from '../../lib/agent-account.js';
import { authenticateToken } from '../../middleware/auth.js';
import { log } from '../../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

/** The one body a caller who cannot reach an agent ever sees. */
const NO_THREAD = { error: 'Agent not found' };

router.get('/thread/:username', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const oxyUserId = req.user.id;

    const agent = await loadThreadAgent(getDb(), {
      username: String(req.params.username),
      oxyUserId,
      accessToken: req.accessToken,
    });
    if (agent === null) return res.status(404).json(NO_THREAD);

    const thread = await resolveAgentThread(getDb(), {
      oxyUserId,
      agentId: agent._id,
      conversationId: randomUUID(),
      /**
       * The name at the moment the thread opens. `agentPromptName` rather than
       * `agent.name`, because that field is nullable and a thread titled `null`
       * is what an unresolvable Oxy account would otherwise produce.
       */
      titleOnCreate: agentPromptName(agent),
    });

    res.json({
      /**
       * The agent, narrowed to what a thread header draws. Not the whole
       * record: `system_prompt`, `allowed_models` and the rest are `GET
       * /agents/:id`'s business, and a screen that only needs a name should not
       * be the reason a draft's prompt travels.
       */
      agent: {
        _id: agent._id,
        name: agent.name,
        handle: agent.handle,
        color: agent.color,
        tagline: agent.tagline,
        description: agent.description,
      },
      conversationId: thread.conversationId,
    });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error resolving an agent thread');
    res.status(500).json({ error: 'Failed to open the thread' });
  }
});

export default router;
