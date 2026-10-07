import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/agents/agentOxyAppPermissionRepository.js', () => ({
  listAgentOxyAppPermissions: vi.fn(async () => []),
  deleteAgentOxyAppPermission: vi.fn(),
  upsertAgentOxyAppPermission: vi.fn(),
}));
vi.mock('../tools/oxy-services.js', () => ({
  listOxyAppCatalogs: vi.fn(async () => [{ appId: 'inbox', accountResourceType: 'email_account' }]),
}));
vi.mock('../logger.js', () => ({ log: { agents: { warn: vi.fn() } } }));

afterEach(() => vi.unstubAllEnvs());

it('revokes an untracked Agency grant through the real HTTP owner transport', async () => {
  const requests: string[] = [];
  let isRevoked = false;
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.headers.authorization !== 'Bearer simulated-owner-token') {
      response.writeHead(403).end();
      return;
    }
    if (request.method === 'GET' && request.url === '/capabilities/grants?ownerAccountId=owner-1') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ grants: [{
        id: 'agency-grant', ownerAccountId: 'owner-1',
        actor: { type: 'agent', accountId: 'bot-1' },
        resource: { appId: 'inbox', effectiveAccountId: 'owner-1', resourceType: 'email_account', resourceId: 'owner-1' },
        maximumAutonomy: 'autonomous', expiresAt: null, revokedAt: null, createdAt: new Date().toISOString(),
      }] }));
      return;
    }
    if (request.method === 'DELETE' && request.url === '/capabilities/grants/agency-grant') {
      isRevoked = true;
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Simulated service did not listen');
  vi.stubEnv('OXY_API_URL', `http://127.0.0.1:${address.port}`);
  try {
    const { revokeAllAgentOxyApps } = await import('../agent-oxy-apps.js');
    await revokeAllAgentOxyApps({ _id: 'agent-1', oxyAccountId: 'bot-1', ownerOxyAccountId: 'owner-1' }, 'simulated-owner-token');
    expect(isRevoked).toBe(true);
    expect(requests).toEqual([
      'GET /capabilities/grants?ownerAccountId=owner-1',
      'DELETE /capabilities/grants/agency-grant',
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
