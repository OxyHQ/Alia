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
  listAgentMemory,
  readAgentMemory,
  writeAgentMemory,
} from '../../db/agents/agentMemoryRepository.js';
import type { Request, Response } from 'express';

const router = Router();

async function ownedAgent(req: Request, res: Response) {
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
    res.status(loaded.refusal === 'agent_not_found' ? 404 : refusalStatus(loaded.refusal))
      .json({ error: loaded.refusal === 'agent_not_found' ? 'Agent not found' : refusalMessage(loaded.refusal) });
    return null;
  }
  return loaded.agent;
}

router.get('/:id/memory', authenticateToken, async (req: Request, res: Response) => {
  try {
    const agent = await ownedAgent(req, res);
    if (!agent || !req.user?.id) return;
    const path = typeof req.query.path === 'string' ? req.query.path : undefined;
    if (!path) return res.json({ documents: await listAgentMemory(getDb(), req.user.id, agent._id) });
    parseAgentMemoryPath(path);
    const document = await readAgentMemory(getDb(), req.user.id, agent._id, path);
    const content = document?.content ?? '';
    res.json({ path, content, hash: document?.contentHash ?? hashAgentMemory(''), exists: Boolean(document), prompt: agentMemoryPromptSlice(content) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid memory path' });
  }
});

router.put('/:id/memory', authenticateToken, async (req: Request, res: Response) => {
  try {
    const agent = await ownedAgent(req, res);
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
      return res.status(409).json({ error: error.message, currentHash: error.currentHash, currentContent: error.currentContent });
    }
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to write memory' });
  }
});

export default router;
