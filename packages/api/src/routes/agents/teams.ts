import { Router, type NextFunction, type Request, type Response } from 'express';
import { getDb } from '../../db/index.js';
import { findAgentById } from '../../db/agents/agentRepository.js';
import { createAgentTeam, deleteAgentTeam, findAgentTeam, listAgentTeams } from '../../db/agents/agentTeamRepository.js';
import { authenticateToken } from '../../middleware/auth.js';
import { canReachAgent } from '../../lib/agent-account.js';
import { parseAliaTeamMarkdown, serializeAliaTeamMarkdown } from '../../lib/agent/team-package.js';

const router = Router();
const route = (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };

async function authorizeMembers(req: Request, ids: string[]) {
  const unique = [...new Set(ids)];
  const agents = await Promise.all(unique.map((id) => findAgentById(getDb(), id)));
  for (const agent of agents) {
    if (!agent || await canReachAgent(agent, {
      oxyUserId: req.user!.id,
      accessToken: req.accessToken,
      applicationId: req.serviceApp?.appId,
    }) !== 'reachable') return false;
  }
  return true;
}

router.get('/teams', authenticateToken, route(async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ teams: await listAgentTeams(getDb(), req.user.id) });
}));

router.get('/teams/:teamId', authenticateToken, route(async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const team = await findAgentTeam(getDb(), req.user.id, String(req.params.teamId));
  if (!team) return res.status(404).json({ error: 'Team not found' });
  res.json({ team });
}));

router.post('/teams', authenticateToken, route(async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
  const rawMembers = Array.isArray(req.body?.members) ? req.body.members.slice(0, 50) : [];
  const members: Array<{ agentId: string; role: 'coordinator' | 'member'; position: number }> = rawMembers.flatMap((value: unknown, position: number) => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    if (typeof item.agentId !== 'string') return [];
    return [{ agentId: item.agentId, role: item.role === 'coordinator' ? 'coordinator' as const : 'member' as const, position }];
  });
  if (!name || !members.length || members.filter((m) => m.role === 'coordinator').length !== 1) {
    return res.status(400).json({ error: 'name and exactly one coordinator are required' });
  }
  if (!await authorizeMembers(req, members.map((member) => member.agentId))) return res.status(404).json({ error: 'Agent not found' });
  const channels = (Array.isArray(req.body?.channels) ? req.body.channels : []).slice(0, 50).flatMap((value: unknown) => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    if (typeof item.name !== 'string' || !item.name.trim()) return [];
    return [{
      name: item.name.trim().slice(0, 100),
      instructions: typeof item.instructions === 'string' ? item.instructions.slice(0, 12_000) : '',
      responderPolicy: typeof item.responderPolicy === 'string' ? item.responderPolicy.slice(0, 100) : 'coordinator',
    }];
  });
  const team = await createAgentTeam(getDb(), {
    oxyUserId: req.user.id,
    name,
    instructions: typeof req.body?.instructions === 'string' ? req.body.instructions.slice(0, 24_000) : '',
    members,
    channels,
  });
  res.status(201).json({ team });
}));

router.post('/teams/import', authenticateToken, route(async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  if (typeof req.body?.markdown !== 'string') return res.status(400).json({ error: 'markdown is required' });
  const { manifest, playbook } = parseAliaTeamMarkdown(req.body.markdown);
  const ids = manifest.members.map((member) => member.key);
  if (!await authorizeMembers(req, ids)) return res.status(404).json({ error: 'Every member key must be an accessible agent ID' });
  const team = await createAgentTeam(getDb(), {
    oxyUserId: req.user.id,
    name: manifest.name,
    instructions: playbook || manifest.description,
    members: manifest.members.map((member, position) => ({
      agentId: member.key,
      role: member.key === manifest.coordinator ? 'coordinator' : 'member',
      position,
    })),
    channels: manifest.channels.map((channel) => ({
      name: channel.name,
      instructions: channel.instructions,
      responderPolicy: channel.responder,
    })),
  });
  res.status(201).json({ team });
}));

router.get('/teams/:teamId/export', authenticateToken, route(async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const team = await findAgentTeam(getDb(), req.user.id, String(req.params.teamId));
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const coordinator = team.members.find((member) => member.role === 'coordinator');
  if (!coordinator) return res.status(409).json({ error: 'Team has no coordinator' });
  const markdown = serializeAliaTeamMarkdown({
    format: 'alia.team', version: 1, name: team.name, description: '', coordinator: coordinator.agentId,
    members: team.members.map((member) => ({ key: member.agentId, name: member.agentId, tagline: '', instructions: '', skills: [] })),
    channels: team.channels.map((channel) => ({ key: channel.id, name: channel.name, instructions: channel.instructions, responder: channel.responderPolicy })),
    automations: [],
  }, team.instructions);
  res.type('text/markdown').send(markdown);
}));

router.delete('/teams/:teamId', authenticateToken, route(async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  if (!await deleteAgentTeam(getDb(), req.user.id, String(req.params.teamId))) return res.status(404).json({ error: 'Team not found' });
  res.status(204).end();
}));

export default router;
