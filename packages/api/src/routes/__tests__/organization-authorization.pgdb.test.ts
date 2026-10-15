/** Real router + Postgres + canonical SDK over HTTP; only the outer verified-login boundary is mocked. */
import { createServer, type Server } from 'node:http';
import express, { type Request, type Response, type NextFunction } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    const id = req.headers['x-test-user'];
    if (typeof id === 'string') {
      req.user = { id };
      req.accessToken = req.headers.authorization?.slice(7);
    }
    next();
  },
  oxyClient: {
    users: { getMany: async () => [] },
    assets: { publicUrl: (id: string) => `https://cloud.oxy.so/${id}` },
  },
}));
const { connectPostgres, closePostgres } = await import('../../db/index.js');
const { createOrganization } = await import('../../db/organizations/organizationRepository.js');
const { organizations } = await import('../../db/schema/organizations.js');
const router = (await import('../organization.js')).default;
const { organizationDirectory, withOrganizationSession } = await import(
  '../../lib/organization-access.js'
);
let db: NonNullable<ReturnType<typeof connectPostgres>>;
let api: Server;
let oxy: Server;
let base: string;
let workspaceId: string;
let upstreamStatus = 200;
let removed = false;
let revoked: string | undefined;
const seen: { path: string; authorization?: string; body: Record<string, unknown> }[] = [];
const grants: Record<string, string[]> = {
  owner: [
    'account:read',
    'account:update',
    'account:delete',
    'members:read',
    'members:invite',
    'members:update',
    'members:remove',
    'billing:read',
    'billing:manage',
    'apps:read',
    'apps:update',
  ],
  admin: [
    'account:read',
    'account:update',
    'members:read',
    'members:invite',
    'members:update',
    'members:remove',
    'billing:read',
    'apps:read',
    'apps:update',
  ],
  editor: ['account:read', 'members:read', 'billing:read', 'apps:read', 'apps:update'],
  billing: ['account:read', 'billing:read', 'billing:manage', 'apps:read'],
  viewer: ['account:read', 'members:read', 'apps:read'],
  developer: ['account:read', 'apps:read'],
  outsider: [],
};
const token = (role: string) =>
  `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: role, exp: 4102444800 })).toString('base64url')}.unsigned`;
function organization(id: string) {
  return {
    accountId: id === 'redirect' ? 'canonical' : id,
    name: `Canonical ${id}`,
    username: null,
    organizationType: 'business',
    avatar: null,
    legalName: null,
    websiteUrl: null,
    countryCode: null,
    aliases: [],
    verifiedDomains: [],
    claimStatus: 'claimed',
    status: id === 'hidden' ? 'suppressed' : 'active',
    mergedIntoAccountId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
function node(id: string, role: string) {
  return {
    accountId: id,
    kind: 'organization',
    relationship: 'member',
    callerMembership: {
      status: removed ? 'removed' : 'active',
      role,
      permissions: (grants[role] ?? []).filter((p) => p !== revoked),
    },
  };
}
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('socket missing');
  return `http://127.0.0.1:${a.port}`;
}
beforeAll(async () => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('Postgres required');
  db = connected;
  const row = await createOrganization(db, 'canonical');
  workspaceId = row.id;
  await db
    .update(organizations)
    .set({ creditsPaid: 37, stripeCustomerId: 'cus_preserved' })
    .where(eq(organizations.id, row.id));
  oxy = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part);
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {};
    const path = req.url ?? '';
    seen.push({ path, authorization: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    res.statusCode = upstreamStatus;
    if (upstreamStatus !== 200) {
      res.end(JSON.stringify({ message: 'unavailable' }));
      return;
    }
    const role =
      Object.keys(grants).find((role) => req.headers.authorization === `Bearer ${token(role)}`) ??
      'outsider';
    if (path === '/organizations/batch')
      res.end(
        JSON.stringify({
          items: body.ids
            .filter((id: string) => id !== 'missing')
            .map((id: string) => ({ requestedAccountId: id, organization: organization(id) })),
          missingIds: body.ids.filter((id: string) => id === 'missing'),
        }),
      );
    else if (path === '/accounts')
      res.end(JSON.stringify({ accounts: [node('canonical', role), node('not-local', role)] }));
    else if (path.includes('/members'))
      res.end(
        JSON.stringify(
          req.method === 'GET'
            ? { members: [] }
            : { member: { _id: 'member-1', role: body.role }, success: true },
        ),
      );
    else res.end(JSON.stringify({ account: node(path.split('/').pop() ?? '', role) }));
  });
  process.env.OXY_API_URL = await listen(oxy);
  const app = express();
  app.use(express.json());
  app.use('/organization', router);
  api = createServer(app);
  base = await listen(api);
});
afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve, reject) => api.close((e) => (e ? reject(e) : resolve()))),
    new Promise<void>((resolve, reject) => oxy.close((e) => (e ? reject(e) : resolve()))),
  ]);
  await closePostgres();
  delete process.env.OXY_API_URL;
});
beforeEach(() => {
  seen.length = 0;
  upstreamStatus = 200;
  removed = false;
  revoked = undefined;
});
async function call(method: string, path: string, role: string | null, body?: unknown) {
  const response = await fetch(`${base}/organization${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(role ? { 'x-test-user': role, authorization: `Bearer ${token(role)}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      organization: Record<string, unknown>;
      organizations: unknown[];
      membershipScope?: string;
      agents: unknown[];
    },
  };
}
describe('Oxy permission authority', () => {
  it('permits readers but withholds financial fields from viewer/developer and refuses absent membership', async () => {
    for (const role of ['owner', 'admin', 'editor', 'billing', 'viewer', 'developer']) {
      const result = await call('GET', `/${workspaceId}`, role);
      expect(result.status, role).toBe(200);
      expect(result.body.organization).toMatchObject({
        _id: workspaceId,
        oxyAccountId: 'canonical',
        name: 'Canonical canonical',
        membershipScope: 'organization',
      });
      if (['viewer', 'developer'].includes(role)) {
        expect(result.body.organization.credits).toBeUndefined();
        expect(result.body.organization.stripeCustomerId).toBeUndefined();
      } else expect(result.body.organization.credits).toEqual({ paid: 37 });
    }
    expect((await call('GET', `/${workspaceId}`, 'outsider')).status).toBe(403);
    expect((await call('GET', `/${workspaceId}`, null)).status).toBe(401);
  });
  it('uses exact original concurrent bearers; public identity never forwards auth', async () => {
    await Promise.all([
      call('GET', `/${workspaceId}`, 'owner'),
      call('GET', `/${workspaceId}`, 'viewer'),
    ]);
    expect(
      seen
        .filter((r) => r.path.startsWith('/accounts/'))
        .map((r) => r.authorization)
        .sort(),
    ).toEqual([`Bearer ${token('owner')}`, `Bearer ${token('viewer')}`].sort());
    expect(
      seen.filter((r) => r.path.startsWith('/organizations/')).every((r) => !r.authorization),
    ).toBe(true);
  });
  it('splits billing/settings permissions and honors live revocations', async () => {
    expect(
      (
        await call('PATCH', `/${workspaceId}`, 'billing', {
          settings: { billingEmail: 'finance@example.com' },
        })
      ).status,
    ).toBe(200);
    expect(
      (await call('PATCH', `/${workspaceId}`, 'billing', { settings: { apiCallLimit: 10 } }))
        .status,
    ).toBe(403);
    expect(
      (
        await call('PATCH', `/${workspaceId}`, 'admin', {
          settings: { billingEmail: 'finance@example.com' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('PATCH', `/${workspaceId}`, 'viewer', { settings: { apiCallLimit: 10 } })).status,
    ).toBe(403);
    revoked = 'account:update';
    expect(
      (await call('PATCH', `/${workspaceId}`, 'owner', { settings: { apiCallLimit: 10 } })).status,
    ).toBe(403);
    removed = true;
    expect((await call('GET', `/${workspaceId}`, 'owner')).status).toBe(403);
  });
  it('lists through one membership forest and one bounded directory call', async () => {
    const result = await call('GET', '/', 'viewer');
    expect(result.status).toBe(200);
    expect(result.body.organizations).toHaveLength(1);
    expect(seen.map((r) => r.path)).toEqual(['/accounts', '/organizations/batch']);
  });
  it('rejects independent name/logo/owner writes and non-admin registration', async () => {
    expect((await call('POST', '/', 'owner', { name: 'Independent company' })).status).toBe(400);
    expect((await call('POST', '/', 'viewer', { oxyAccountId: 'new-company' })).status).toBe(403);
    expect((await call('POST', '/', 'owner', { oxyAccountId: 'registered-company' })).status).toBe(
      201,
    );
    expect((await call('POST', '/', 'owner', { oxyAccountId: 'registered-company' })).status).toBe(
      409,
    );
    expect(
      (
        await call('PATCH', `/${workspaceId}`, 'owner', {
          name: 'Renamed',
          image: 'local',
          ownerId: 'person',
        })
      ).status,
    ).toBe(400);
    expect((await call('POST', `/${workspaceId}/logo`, 'owner', {})).status).toBe(410);
  });
  it('keeps deletion from erasing billing and historical relationships', async () => {
    expect((await call('DELETE', `/${workspaceId}`, 'viewer')).status).toBe(403);
    expect((await call('DELETE', `/${workspaceId}`, 'owner')).status).toBe(409);
    const [row] = await db.select().from(organizations).where(eq(organizations.id, workspaceId));
    expect(row).toMatchObject({ creditsPaid: 37, stripeCustomerId: 'cus_preserved' });
  });
  it('forwards membership operations to Oxy with organization-global semantics and no owner invitations', async () => {
    expect(
      (
        await call('POST', `/${workspaceId}/members`, 'viewer', {
          usernameOrEmail: 'colleague',
          role: 'admin',
        })
      ).status,
    ).toBe(403);
    const result = await call('POST', `/${workspaceId}/members`, 'admin', {
      usernameOrEmail: 'colleague',
      role: 'viewer',
    });
    expect(result.status).toBe(201);
    expect(result.body.membershipScope).toBe('organization');
    expect(seen.find((r) => r.path === '/accounts/canonical/members')?.body).toEqual({
      usernameOrEmail: 'colleague',
      role: 'viewer',
    });
    expect(
      (
        await call('POST', `/${workspaceId}/members`, 'owner', {
          usernameOrEmail: 'colleague',
          role: 'owner',
        })
      ).status,
    ).toBe(400);
    expect(
      (await call('PATCH', `/${workspaceId}/members/member-1`, 'admin', { role: 'editor' })).status,
    ).toBe(200);
    expect((await call('DELETE', `/${workspaceId}/members/member-1`, 'admin')).status).toBe(200);
  });
  it('rejects retired link redemption and refuses viewers sharing agents', async () => {
    for (const action of ['info', 'accept', 'decline'])
      expect(
        (await call(action === 'info' ? 'GET' : 'POST', `/invites/old-secret/${action}`, 'owner'))
          .status,
      ).toBe(410);
    expect(
      (await call('POST', `/${workspaceId}/agents`, 'viewer', { agentId: 'someone-elses-agent' }))
        .status,
    ).toBe(403);
    expect((await call('GET', `/${workspaceId}/agents`, 'viewer')).body.agents).toEqual([]);
  });
  it('fails closed on upstream outage', async () => {
    upstreamStatus = 503;
    expect(
      (await call('PATCH', `/${workspaceId}`, 'owner', { settings: { apiCallLimit: 20 } })).status,
    ).toBe(503);
  });
  it('deduplicates >100 identities and respects suppression/missing/redirects', async () => {
    const ids = [
      ...Array.from({ length: 201 }, (_, i) => `company-${i}`),
      'company-0',
      'hidden',
      'missing',
      'redirect',
    ];
    const result = await withOrganizationSession(token('owner'), (client) =>
      organizationDirectory(client, ids),
    );
    expect(seen.map((r) => (r.body.ids as string[]).length)).toEqual([100, 100, 4]);
    expect(result.size).toBe(202);
    expect(result.get('redirect')?.accountId).toBe('canonical');
    expect(result.has('hidden')).toBe(false);
    expect(result.has('missing')).toBe(false);
  });
});
