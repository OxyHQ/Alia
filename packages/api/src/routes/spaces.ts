/**
 * Spaces (ADR 0028): folders that group a person's agents.
 *
 * Every route is the caller's own: a space is found by `(oxy_user_id, id)`, so another person's is
 * indistinguishable from a missing one. Putting an agent in a space is a write on the agent, so the
 * caller must hold standing over its bot account (`loadAgentForActor`, asked of Oxy afresh), exactly as
 * for every other agent write. Alia is never a member: members are agent rows and she has none.
 */

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import {
  createSpace,
  deleteSpace,
  findSpace,
  listSpaces,
  setAgentSpace,
  updateSpace,
  type SetAgentSpaceResult,
  type SpaceWithMembers,
} from '../db/spaces/spaceRepository.js';
import { getDb } from '../db/index.js';
import { MAX_SPACE_MEMBERS, parseSpaceInstructions, parseSpaceName } from '../domain/spaces.js';
import { loadAgentForActor, refusalMessage, refusalStatus } from '../lib/agent-account.js';
import { log } from '../lib/logger.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();
router.use(authenticateToken);

const wire = (space: SpaceWithMembers) => ({
  id: space.id,
  name: space.name,
  instructions: space.instructions,
  /** The space's room: a group conversation, opened like any other. */
  conversationId: space.conversationId,
  memberAgentIds: space.memberAgentIds,
  createdAt: space.createdAt,
  updatedAt: space.updatedAt,
});

const callerOf = (req: Request): { userId: string; accessToken: string } | null =>
  req.user?.id && req.accessToken ? { userId: req.user.id, accessToken: req.accessToken } : null;

/** Standing over an agent, asked afresh. On refusal the response is already written. */
async function mayMove(req: Request, res: Response, agentId: string): Promise<boolean> {
  const caller = callerOf(req);
  if (!caller) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  const loaded = await loadAgentForActor(getDb(), {
    agentId,
    oxyUserId: caller.userId,
    accessToken: caller.accessToken,
    cache: false,
  });
  if (loaded.ok) return true;
  res.status(loaded.refusal === 'agent_not_found' ? 404 : refusalStatus(loaded.refusal)).json({
    error:
      loaded.refusal === 'agent_not_found' ? 'Agent not found' : refusalMessage(loaded.refusal),
  });
  return false;
}

function refusePlacement(res: Response, result: Exclude<SetAgentSpaceResult, { ok: true }>): void {
  switch (result.reason) {
    case 'space_full':
      res.status(409).json({
        error: `A space holds at most ${MAX_SPACE_MEMBERS} agents`,
        code: 'space_full',
      });
      return;
    case 'agent_in_other_space':
      res
        .status(409)
        .json({ error: 'That agent is in another person’s space', code: result.reason });
      return;
    case 'space_not_found':
      res.status(404).json({ error: 'Space not found' });
      return;
    case 'agent_not_found':
      res.status(404).json({ error: 'Agent not found' });
      return;
  }
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const caller = callerOf(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ spaces: (await listSpaces(getDb(), caller.userId)).map(wire) });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Could not list spaces');
    res.status(500).json({ error: 'Could not list your spaces' });
  }
});

const createSchema = z
  .object({
    name: z.unknown(),
    instructions: z.unknown().optional(),
    /** Agents to put in at once, in the order they answer. */
    agentIds: z.array(z.string().min(1)).max(MAX_SPACE_MEMBERS).optional(),
  })
  .strict();

router.post('/', async (req: Request, res: Response) => {
  try {
    const caller = callerOf(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });
    const body = createSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid space' });
    const name = parseSpaceName(body.data.name);
    if (!name.ok) return res.status(400).json({ error: name.error });
    const instructions = parseSpaceInstructions(body.data.instructions);
    if (!instructions.ok) return res.status(400).json({ error: instructions.error });
    const agentIds = [...new Set(body.data.agentIds ?? [])];

    // Standing over every agent BEFORE anything is written: a space is never created half-filled.
    for (const agentId of agentIds) {
      if (!(await mayMove(req, res, agentId))) return;
    }
    const created = await createSpace(getDb(), {
      oxyUserId: caller.userId,
      name: name.name,
      instructions: instructions.instructions,
    });
    for (const agentId of agentIds) {
      const placed = await setAgentSpace(getDb(), {
        oxyUserId: caller.userId,
        agentId,
        spaceId: created.id,
      });
      if (!placed.ok) {
        // Undo the space rather than leave an empty one the person did not ask for.
        await deleteSpace(getDb(), caller.userId, created.id).catch(() => undefined);
        return refusePlacement(res, placed);
      }
    }
    const space = await findSpace(getDb(), caller.userId, created.id);
    res.status(201).json({ space: space ? wire(space) : wire(created) });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Could not create a space');
    res.status(500).json({ error: 'Could not create the space' });
  }
});

const patchSchema = z
  .object({ name: z.unknown().optional(), instructions: z.unknown().optional() })
  .strict();

router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const caller = callerOf(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });
    const body = patchSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid space' });
    const patch: { name?: string; instructions?: string } = {};
    if (body.data.name !== undefined) {
      const name = parseSpaceName(body.data.name);
      if (!name.ok) return res.status(400).json({ error: name.error });
      patch.name = name.name;
    }
    if (body.data.instructions !== undefined) {
      const instructions = parseSpaceInstructions(body.data.instructions);
      if (!instructions.ok) return res.status(400).json({ error: instructions.error });
      patch.instructions = instructions.instructions;
    }
    const space = await updateSpace(getDb(), caller.userId, String(req.params.id), patch);
    if (!space) return res.status(404).json({ error: 'Space not found' });
    res.json({ space: wire(space) });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Could not update a space');
    res.status(500).json({ error: 'Could not update the space' });
  }
});

router.put('/:id/members/:agentId', async (req: Request, res: Response) => {
  try {
    const caller = callerOf(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });
    const agentId = String(req.params.agentId);
    // The space first: a space that is not theirs is the same 404 whether or not the agent exists.
    if (!(await findSpace(getDb(), caller.userId, String(req.params.id)))) {
      return res.status(404).json({ error: 'Space not found' });
    }
    if (!(await mayMove(req, res, agentId))) return;
    const placed = await setAgentSpace(getDb(), {
      oxyUserId: caller.userId,
      agentId,
      spaceId: String(req.params.id),
    });
    if (!placed.ok) return refusePlacement(res, placed);
    res.json({ space: placed.space ? wire(placed.space) : null });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Could not put an agent in a space');
    res.status(500).json({ error: 'Could not move the agent' });
  }
});

router.delete('/:id/members/:agentId', async (req: Request, res: Response) => {
  try {
    const caller = callerOf(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });
    const agentId = String(req.params.agentId);
    const space = await findSpace(getDb(), caller.userId, String(req.params.id));
    if (!space || !space.memberAgentIds.includes(agentId)) {
      return res.status(404).json({ error: 'Agent is not in that space' });
    }
    if (!(await mayMove(req, res, agentId))) return;
    const removed = await setAgentSpace(getDb(), {
      oxyUserId: caller.userId,
      agentId,
      spaceId: null,
    });
    if (!removed.ok) return refusePlacement(res, removed);
    res.status(204).end();
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Could not take an agent out of a space');
    res.status(500).json({ error: 'Could not move the agent' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const caller = callerOf(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });
    if (!(await deleteSpace(getDb(), caller.userId, String(req.params.id)))) {
      return res.status(404).json({ error: 'Space not found' });
    }
    res.status(204).end();
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Could not delete a space');
    res.status(500).json({ error: 'Could not delete the space' });
  }
});

export default router;
