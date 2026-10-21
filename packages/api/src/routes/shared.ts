/**
 * `GET /v1/shared/:token` — a conversation somebody shared, read by anyone
 * holding the link (`docs/agent-embedding.md` §6).
 *
 * No authentication: the token IS the authority, minted by the owner through
 * `POST /v1/conversations/:id/share` and valid until it expires or they revoke
 * it. Every failure — unknown, expired, revoked, a conversation since deleted —
 * is the same 404, so a token cannot be probed for which of them it was.
 *
 * `X-Robots-Tag: noindex` because a link is shared with people, not with search
 * engines, and `Cache-Control: no-store` because a revoked link must stop
 * working for a reader who already opened it.
 */

import { Router, type Request, type Response } from 'express';
import { findAgentById } from '../db/agents/agentRepository.js';
import { findConversation } from '../db/chat/conversationRepository.js';
import { findLiveShare, shareTokenHash } from '../db/chat/conversationShareRepository.js';
import { listMessages } from '../db/chat/messageRepository.js';
import { getDb } from '../db/index.js';
import { agentPromptName, attachAgentIdentity } from '../lib/agent-identity.js';
import { log } from '../lib/logger.js';
import { sharedMessagesOf, type SharedAgent } from '../lib/shared-conversation.js';
import { checkWindowLimit } from '../lib/sliding-window-limiter.js';

const router = Router();

/**
 * Reads of one link per minute. Keyed by the link rather than the reader: what
 * the limit protects is one forwarded link being hammered, by however many
 * readers. Guessing a token is not what it stops — 256 random bits do that.
 */
const SHARED_READS_PER_MINUTE = 60;

/** The shape of a token `shareConversation` mints: 32 bytes, base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

async function conversationAgent(agentId: string | null): Promise<SharedAgent | undefined> {
  if (agentId === null) return undefined;
  const agent = await findAgentById(getDb(), agentId);
  if (agent === null) return undefined;
  const hydrated = await attachAgentIdentity(agent);
  return {
    id: hydrated.id,
    name: agentPromptName(hydrated),
    handle: hydrated.handle ?? '',
    color: hydrated.color,
    character: hydrated.character,
  };
}

router.get('/:token', async (req: Request, res: Response) => {
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Cache-Control', 'no-store');
  const notFound = () => res.status(404).json({ error: 'Shared conversation not found' });
  try {
    const token = String(req.params.token);
    if (!TOKEN.test(token)) return notFound();

    const limit = await checkWindowLimit(
      `rl:shared:${shareTokenHash(token)}`,
      SHARED_READS_PER_MINUTE,
    );
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.resetInSeconds ?? 60));
      return res.status(429).json({ error: 'Too many requests' });
    }

    const share = await findLiveShare(getDb(), token);
    if (share === null) return notFound();
    const conversation = await findConversation(getDb(), share.oxyUserId, share.conversationId);
    if (conversation === undefined) return notFound();

    const [rows, agent] = await Promise.all([
      listMessages(getDb(), share.oxyUserId, share.conversationId),
      conversationAgent(conversation.agentId),
    ]);
    res.json({
      title: conversation.title,
      ...(agent === undefined ? {} : { agent }),
      messages: sharedMessagesOf(rows),
      expiresAt: share.expiresAt,
    });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error reading a shared conversation');
    res.status(500).json({ error: 'Failed to read the shared conversation' });
  }
});

export default router;
