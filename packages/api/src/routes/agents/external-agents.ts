/**
 * External agents (ADR 0028): pair a person's coding-agent CLI with Alia so it appears as one of
 * their agents.
 *
 *   POST   /agents/external/pair          the app mints a single-use code + the prompt to paste
 *   POST   /agents/external/redeem        the daemon trades the code for an agent (same account)
 *   GET    /agents/external               the person's external agents, with live presence
 *   DELETE /agents/external/:agentId      revoke: the link dies and the daemon is cut off
 *
 * `redeem` is called by the daemon with the person's own Oxy session, so the account that minted
 * the code and the account that redeems it are the same by construction — the SQL requires it.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { avatarCharacterFor } from '@oxy.so/contracts';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { createAgent } from '../../db/agents/agentRepository.js';
import {
  createExternalLink,
  createPairing,
  listExternalLinks,
  redeemPairing,
  revokeExternalLink,
} from '../../db/agents/externalAgentRepository.js';
import {
  EXTERNAL_AGENT_CLIS,
  EXTERNAL_PAIRING_TTL_MS,
  type ExternalAgentCli,
} from '../../domain/external-agent.js';
import { agentColorFor } from '../../domain/agent-color.js';
import { authenticateToken } from '../../middleware/auth.js';
import { createAgentBotAccount } from '../../lib/agent-account.js';
import { fallbackAgentUsername, suggestAgentUsername } from '../../lib/agent-identity.js';
import { getErrorMessage } from '../../lib/errors/index.js';
import { log } from '../../lib/logger.js';
import { buildInvitePrompt, inviteLocaleOf } from '../../lib/external-agents/invite-prompt.js';
import {
  generatePairingCode,
  hashPairingCode,
  isWellFormedPairingCode,
} from '../../lib/external-agents/pairing-code.js';
import {
  disconnectExternalAgent,
  isExternalAgentReachable,
} from '../../lib/external-agents/relay.js';

const router = Router();
const route =
  (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };

const CLI_LABELS: Record<ExternalAgentCli, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

const redeemSchema = z
  .object({
    code: z.string().min(1).max(64),
    cli: z.enum(EXTERNAL_AGENT_CLIS),
    hostName: z.string().trim().min(1).max(80),
  })
  .strict();

const MAX_PENDING_PAIRINGS_WINDOW_MS = 60_000;
const recentPairings = new Map<string, number[]>();

/** Five codes a minute per account is far more than a person pairing machines needs. */
function pairingRateLimited(userId: string, now: number): boolean {
  const recent = (recentPairings.get(userId) ?? []).filter(
    (at) => now - at < MAX_PENDING_PAIRINGS_WINDOW_MS,
  );
  if (recent.length >= 5) {
    recentPairings.set(userId, recent);
    return true;
  }
  recent.push(now);
  recentPairings.set(userId, recent);
  return false;
}

router.post(
  '/external/pair',
  authenticateToken,
  route(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    if (pairingRateLimited(req.user.id, Date.now())) {
      return res.status(429).json({ error: 'Too many pairing codes; wait a minute' });
    }
    const code = generatePairingCode();
    const expiresAt = new Date(Date.now() + EXTERNAL_PAIRING_TTL_MS);
    await createPairing(getDb(), {
      id: randomUUID(),
      codeHash: hashPairingCode(code),
      ownerOxyUserId: req.user.id,
      expiresAt,
    });
    const locale = inviteLocaleOf(req.body?.locale);
    res.status(201).json({
      code,
      expiresAt: expiresAt.toISOString(),
      prompt: buildInvitePrompt({ code, locale }),
    });
  }),
);

router.post(
  '/external/redeem',
  authenticateToken,
  route(async (req, res) => {
    if (!req.user?.id || req.accessToken === undefined) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const parsed = redeemSchema.safeParse(req.body);
    if (!parsed.success || !isWellFormedPairingCode(parsed.data.code)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const { cli, hostName } = parsed.data;
    const userId = req.user.id;

    const redeemed = await redeemPairing(getDb(), {
      codeHash: hashPairingCode(parsed.data.code),
      ownerOxyUserId: userId,
      now: new Date(),
    });
    if (redeemed === null) {
      return res.status(400).json({ error: 'invalid_or_expired_code' });
    }

    try {
      const name = `${CLI_LABELS[cli]} · ${hostName}`;
      const username = suggestAgentUsername(CLI_LABELS[cli]) ?? fallbackAgentUsername();
      const character = avatarCharacterFor(username);
      const tagline = `${CLI_LABELS[cli]} on ${hostName}`;
      const account = await createAgentBotAccount({
        accessToken: req.accessToken,
        username,
        displayName: name,
        bio: tagline,
        color: agentColorFor(username),
        character,
      });
      const agent = await createAgent(getDb(), {
        oxyAccountId: account.oxyAccountId,
        ownerOxyAccountId: userId,
        character,
        tagline,
        description: `${CLI_LABELS[cli]} running on ${hostName}, connected to Alia through the Codea daemon.`,
        authorOxyUserId: userId,
        category: 'Assistant',
        isPublished: false,
        access: 'private',
      });
      await createExternalLink(getDb(), {
        agentId: agent._id,
        ownerOxyUserId: userId,
        cli,
        hostName,
      });
      log.general.info({ agentId: agent._id, cli, userId }, 'External agent paired');
      res.status(201).json({ agentId: agent._id, name, handle: account.username, cli });
    } catch (err: unknown) {
      log.general.error({ err }, 'External agent pairing failed after the code was redeemed');
      res.status(502).json({ error: 'pairing_failed', message: getErrorMessage(err) });
    }
  }),
);

router.get(
  '/external',
  authenticateToken,
  route(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const links = await listExternalLinks(getDb(), req.user.id);
    const online = await Promise.all(links.map((link) => isExternalAgentReachable(link.agentId)));
    res.json({
      agents: links.map((link, index) => ({
        agentId: link.agentId,
        cli: link.cli,
        hostName: link.hostName,
        online: online[index],
        createdAt: link.createdAt,
        lastConnectedAt: link.lastConnectedAt,
      })),
    });
  }),
);

router.delete(
  '/external/:agentId',
  authenticateToken,
  route(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const agentId = String(req.params.agentId);
    const revoked = await revokeExternalLink(getDb(), req.user.id, agentId);
    if (!revoked) return res.status(404).json({ error: 'Not found' });
    disconnectExternalAgent(agentId);
    res.status(204).end();
  }),
);

export default router;
