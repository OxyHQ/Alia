/**
 * The agent's computer, as the person it works for sees it: the live browser
 * (screenshot polling, and taking over for a login or a captcha), the files in
 * its `/workspace` (read-only) and what it recently ran.
 *
 *   GET  /agents/:id/computer                         { granted, computer, browser }
 *   POST /agents/:id/computer/start                   start the computer (to see its files)
 *   GET  /agents/:id/computer/files?path=             list a directory (read-only)
 *   GET  /agents/:id/computer/files/content?path=     read a text file (read-only)
 *   GET  /agents/:id/computer/receipts                recent commands and browser actions
 *   GET  /agents/:id/computer/browser/screenshot      { mimeType, data } — base64 JPEG
 *   POST /agents/:id/computer/browser/open            { url? }
 *   POST /agents/:id/computer/browser/navigate        { url }
 *   POST /agents/:id/computer/browser/input           { input }
 *   POST /agents/:id/computer/browser/control         { controller: 'owner' | 'agent' }
 *
 * ## Whose computer — the authorisation IS the actor id
 *
 * An agent has one computer per person (`agent:<agentId>:user:<oxyUserId>`,
 * `lib/computer/computer-client.ts`). Every route here composes that id from
 * the agent in the path and the CALLER's verified Oxy user — never from
 * anything the request names. So a person can only ever reach their own
 * computer with an agent: the creator of a public agent cannot open the
 * computer it uses for somebody else, and nobody can name another person's.
 * On top of that the caller must be able to reach the agent at all
 * (`canReachAgent`, the same rule as its threads); otherwise it is "not found".
 *
 * Input here is always the OWNER's (`by: 'owner'`): it takes the browser over,
 * and the agent's own actions are refused until the person hands it back
 * (`control: 'agent'`) or walks away for 15 minutes.
 *
 * Polling never wakes a sleeping host: status, receipts and the screenshot of a
 * browser that is not open answer from what is known. Typed text is passed
 * through and never logged or stored (the host's receipts record only that
 * something was typed, and how much).
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { findAgentById } from '../../db/agents/agentRepository.js';
import { canReachAgent } from '../../lib/agent-account.js';
import { readCapabilityGrants } from '../../domain/capability-grants.js';
import {
  ComputerHostError,
  agentActorId,
  getComputerClient,
  type ComputerClient,
} from '../../lib/computer/computer-client.js';
import { BROWSER_KEYS } from '../../lib/computer/browser-tools.js';
import { authenticateToken } from '../../middleware/auth.js';

const router = Router();

const route = (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };

const pathSchema = z.string().min(1).max(2048).startsWith('/workspace');
// The host decides what is reachable; this only refuses what is not a web address.
const urlSchema = z.string().max(8192).regex(/^https?:\/\/[^\s]+$/i, 'Use an http(s) address');
const inputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), x: z.number().int().min(0).max(1279), y: z.number().int().min(0).max(799) }).strict(),
  z.object({ type: z.literal('type'), text: z.string().min(1).max(2000) }).strict(),
  z.object({ type: z.literal('key'), key: z.enum(BROWSER_KEYS) }).strict(),
  z.object({ type: z.literal('scroll'), deltaY: z.number().int().min(-5000).max(5000) }).strict(),
]);

interface Owned {
  client: ComputerClient;
  actorId: string;
  granted: boolean;
}

/**
 * The caller's own computer with this agent, or a response already sent.
 *
 * Exported for the suite: the rule it encodes is the whole security model of
 * this file.
 */
export async function ownComputer(req: Request, res: Response): Promise<Owned | null> {
  const oxyUserId = req.user?.id;
  if (!oxyUserId) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const agent = await findAgentById(getDb(), String(req.params.id));
  const reach = agent
    ? await canReachAgent(agent, { oxyUserId, accessToken: req.accessToken, applicationId: req.serviceApp?.appId })
    : 'out_of_reach';
  if (!agent || reach === 'out_of_reach') {
    res.status(404).json({ error: 'Agent not found' });
    return null;
  }
  if (reach !== 'reachable') {
    res.status(503).json({ error: 'identity_unavailable', message: 'Try again shortly.' });
    return null;
  }
  const client = getComputerClient();
  if (!client) {
    res.status(404).json({ error: 'computer_unavailable', message: 'This deployment has no agent computers.' });
    return null;
  }
  return {
    client,
    actorId: agentActorId(agent._id, oxyUserId),
    granted: readCapabilityGrants(agent.capabilityGrants).allows('computer'),
  };
}

function hostFailure(res: Response, error: unknown) {
  if (error instanceof ComputerHostError) {
    // A host-side 5xx is "unavailable" to the app; never the host's wording.
    const status = error.status >= 500 || error.status < 400 ? 503 : error.status;
    res.status(status).json({ error: error.code, message: status === 503 ? 'The computer is unavailable right now.' : error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'invalid_request', message: error.issues[0]?.message ?? 'Invalid request' });
    return;
  }
  res.status(503).json({ error: 'host_unavailable', message: 'The computer is unavailable right now.' });
}

const withComputer = (handler: (owned: Owned, req: Request, res: Response) => Promise<unknown>) =>
  route(async (req, res) => {
    const owned = await ownComputer(req, res);
    if (!owned) return;
    try {
      const body = await handler(owned, req, res);
      if (!res.headersSent) res.json(body);
    } catch (error) {
      hostFailure(res, error);
    }
  });

router.get('/:id/computer', authenticateToken, withComputer(async ({ client, actorId, granted }) => {
  const [computer, browser] = await Promise.all([client.status(actorId), client.browserStatus(actorId)]);
  return { granted, computer, browser };
}));

router.post('/:id/computer/start', authenticateToken, withComputer(async ({ client, actorId }) => ({
  computer: await client.start(actorId),
})));

router.get('/:id/computer/files', authenticateToken, withComputer(async ({ client, actorId }, req) => {
  const path = pathSchema.parse(typeof req.query.path === 'string' ? req.query.path : '/workspace');
  return client.list(actorId, path);
}));

router.get('/:id/computer/files/content', authenticateToken, withComputer(async ({ client, actorId }, req) => {
  const path = pathSchema.parse(req.query.path);
  return client.read(actorId, path);
}));

router.get('/:id/computer/receipts', authenticateToken, withComputer(async ({ client, actorId }) => {
  const [commands, browser] = await Promise.all([client.recentCommands(actorId, 20), client.browserActions(actorId, 20)]);
  return {
    // What ran, how it ended, when. Output stays on the computer.
    commands: commands.map((receipt) => ({
      operationId: receipt.operationId,
      command: receipt.command.slice(0, 500),
      cwd: receipt.cwd,
      background: receipt.background,
      status: receipt.status,
      exitCode: receipt.exitCode,
      startedAt: receipt.startedAt,
      completedAt: receipt.completedAt,
    })),
    browser,
  };
}));

router.get('/:id/computer/browser/screenshot', authenticateToken, withComputer(async ({ client, actorId }, _req, res) => {
  const bytes = await client.browserScreenshot(actorId);
  res.set('cache-control', 'no-store');
  return { mimeType: 'image/jpeg', width: 1280, height: 800, data: bytes.toString('base64') };
}));

router.post('/:id/computer/browser/open', authenticateToken, withComputer(async ({ client, actorId }, req) => {
  const url = z.object({ url: urlSchema.optional() }).strict().parse(req.body ?? {}).url;
  return client.browserOpen(actorId, url, 'owner');
}));

router.post('/:id/computer/browser/navigate', authenticateToken, withComputer(async ({ client, actorId }, req) => {
  const { url } = z.object({ url: urlSchema }).strict().parse(req.body);
  return client.browserNavigate(actorId, url, 'owner');
}));

router.post('/:id/computer/browser/input', authenticateToken, withComputer(async ({ client, actorId }, req) => {
  const { input } = z.object({ input: inputSchema }).strict().parse(req.body);
  return client.browserInput(actorId, input, 'owner');
}));

router.post('/:id/computer/browser/control', authenticateToken, withComputer(async ({ client, actorId }, req) => {
  const { controller } = z.object({ controller: z.enum(['owner', 'agent']) }).strict().parse(req.body);
  return client.browserControl(actorId, controller);
}));

export default router;
