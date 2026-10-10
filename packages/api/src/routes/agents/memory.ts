import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { loadAgentForActor, refusalMessage, refusalStatus } from '../../lib/agent-account.js';
import { authenticateToken } from '../../middleware/auth.js';
import { redactSecrets } from '../../lib/agent/secret-scanner.js';
import {
  AGENT_MEMORY_FILE_MAX_BYTES,
  agentMemoryPromptSlice,
  hashAgentMemory,
  parseAgentMemoryPath,
} from '../../lib/agent/memory-contract.js';
import {
  AgentMemoryConflictError,
  deleteAgentMemory,
  listAgentMemory,
  readAgentMemory,
  writeAgentMemory,
} from '../../db/agents/agentMemoryRepository.js';
import { findAgentById } from '../../db/agents/agentRepository.js';
import type { Request, Response } from 'express';

const router = Router();

/**
 * The agent whose memory of the CALLER this request may read or change.
 *
 * The rows are always the caller's own (`oxy_user_id = req.user.id`): an
 * agent's memory is of one person, and nobody — not even the agent's owner —
 * reads another person's through here. What is decided is only whether the
 * caller may address this agent at all:
 *
 * - it already remembers something about them (they talked to it — a public
 *   agent included), so they can see and forget it; or
 * - they may act as its bot account (its owner or an operator), checked with
 *   Oxy, as every agent write path is (`loadAgentForActor`).
 *
 * Anybody else gets the same 404 an unknown agent does.
 */
async function agentForMemory(req: Request, res: Response) {
  if (!req.user?.id || !req.accessToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const agentId = String(req.params.id);
  const agent = await findAgentById(getDb(), agentId);
  if (agent && (await listAgentMemory(getDb(), req.user.id, agent._id)).length > 0) return agent;
  const loaded = await loadAgentForActor(getDb(), {
    agentId,
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

router.get('/:id/memory', authenticateToken, async (req: Request, res: Response) => {
  try {
    const agent = await agentForMemory(req, res);
    if (!agent || !req.user?.id) return;
    const path = typeof req.query.path === 'string' ? req.query.path : undefined;
    if (!path)
      return res.json({ documents: await listAgentMemory(getDb(), req.user.id, agent._id) });
    parseAgentMemoryPath(path);
    const document = await readAgentMemory(getDb(), req.user.id, agent._id, path);
    const content = document?.content ?? '';
    res.json({
      path,
      content,
      hash: document?.contentHash ?? hashAgentMemory(''),
      exists: Boolean(document),
      prompt: agentMemoryPromptSlice(content),
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid memory path' });
  }
});

router.put('/:id/memory', authenticateToken, async (req: Request, res: Response) => {
  try {
    const agent = await agentForMemory(req, res);
    if (!agent || !req.user?.id) return;
    const path = typeof req.body?.path === 'string' ? req.body.path : '';
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const expectedHash = typeof req.body?.expectedHash === 'string' ? req.body.expectedHash : '';
    parseAgentMemoryPath(path);
    if (!expectedHash) return res.status(400).json({ error: 'expectedHash is required' });
    if (Buffer.byteLength(content, 'utf8') > AGENT_MEMORY_FILE_MAX_BYTES) {
      return res.status(413).json({ error: 'Memory document is too large' });
    }
    const safe = redactSecrets(content);
    const document = await writeAgentMemory(getDb(), {
      oxyUserId: req.user.id,
      agentId: agent._id,
      actorOxyAccountId: req.user.id,
      path,
      content: safe.redacted,
      expectedHash,
      origin: 'person',
    });
    res.json({ document, redactedSecrets: safe.matches.map((match) => match.type) });
  } catch (error) {
    if (error instanceof AgentMemoryConflictError) {
      return res.status(409).json({
        error: error.message,
        currentHash: error.currentHash,
        currentContent: error.currentContent,
      });
    }
    res
      .status(400)
      .json({ error: error instanceof Error ? error.message : 'Failed to write memory' });
  }
});

/**
 * DELETE /agents/:id/memory[?path=…] — "olvidar".
 *
 * One file with `path`, everything this agent remembers about the caller
 * without it. The file goes with its journal (`deleteAgentMemory`), so a
 * forgotten note is not kept as history either.
 */
router.delete('/:id/memory', authenticateToken, async (req: Request, res: Response) => {
  try {
    const agent = await agentForMemory(req, res);
    if (!agent || !req.user?.id) return;
    const path = typeof req.query.path === 'string' ? req.query.path : undefined;
    if (path !== undefined) parseAgentMemoryPath(path);
    const removed = await deleteAgentMemory(getDb(), {
      oxyUserId: req.user.id,
      agentId: agent._id,
      ...(path === undefined ? {} : { path }),
    });
    res.json({ removed });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid memory path' });
  }
});

export default router;
