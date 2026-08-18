/**
 * `X-Workspace-Id` becomes a workspace only after the membership is proved.
 *
 * This middleware is the only thing standing between a header a caller writes
 * and the `organization_id` `routes/developer.ts` filters and writes by. Get it
 * wrong in the permissive direction and a caller reads and writes another
 * tenant's developer applications by typing an id — no error, no log line, and
 * `developer_apps.organization_id` accepts it because the foreign key only asks
 * whether the organization EXISTS.
 *
 * A real database, because the check IS a row lookup: mocking the repository
 * would leave a test of the mock's membership table.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * No `vi.mock` of the auth middleware here, and its absence is the point:
 * `workspace.ts` does not import it. `req.user` is set by whatever ran before —
 * `index.ts` mounts `authenticateToken` — so the harness below sets it directly
 * and the suite tests this middleware rather than that one.
 */

const { closePostgres, connectPostgres } = await import('../../db/index.js');
const { createOrganization } = await import('../../db/organizations/organizationRepository.js');
const { organizationMembers, organizations } = await import('../../db/schema/organizations.js');
const { resolveWorkspace } = await import('../workspace.js');

let db: NonNullable<ReturnType<typeof connectPostgres>>;
let base: string;
let server: Server;

const OWNER = 'wsscope-owner';
const MEMBER = 'wsscope-member';
const OUTSIDER = 'wsscope-outsider';

const created: string[] = [];

beforeAll(async () => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;

  const app: Express = express();
  // The authentication the real mount puts in front of it — `index.ts` mounts
  // `authenticateToken` then `resolveWorkspace`, and the order is load bearing:
  // the 401 branch below exists only because `req.user` may be absent.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const id = req.headers['x-test-user'];
    if (typeof id === 'string' && id !== '') req.user = { id };
    next();
  });
  app.use(resolveWorkspace);
  app.get('/scope', (req: Request, res: Response) => {
    res.json({ workspace: req.workspace });
  });
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await closePostgres();
});

afterEach(async () => {
  if (created.length === 0) return;
  await db.delete(organizations).where(inArray(organizations.id, [...created]));
  created.length = 0;
});

let slugCounter = 0;

async function anOrganization(): Promise<string> {
  slugCounter += 1;
  const organization = await createOrganization(db, {
    name: 'Acme',
    slug: `wsscope-slug-${String(slugCounter)}`,
    ownerId: OWNER,
  });
  if (!organization) throw new Error('fixture organization was refused');
  created.push(organization.id);
  await db
    .insert(organizationMembers)
    .values({ organizationId: organization.id, oxyUserId: MEMBER, role: 'member' });
  return organization.id;
}

async function scope(headers: Record<string, string>) {
  const res = await fetch(`${base}/scope`, { headers });
  return { status: res.status, body: (await res.json()) as { workspace?: unknown } };
}

describe('resolving X-Workspace-Id', () => {
  it('is the personal workspace when the header is absent or says so', async () => {
    expect(await scope({ 'x-test-user': MEMBER })).toEqual({
      status: 200,
      body: { workspace: { id: null } },
    });
    expect(await scope({ 'x-test-user': MEMBER, 'x-workspace-id': 'personal' })).toEqual({
      status: 200,
      body: { workspace: { id: null } },
    });
  });

  it('carries the id AND the role for a member', async () => {
    const id = await anOrganization();

    expect(await scope({ 'x-test-user': MEMBER, 'x-workspace-id': id })).toEqual({
      status: 200,
      body: { workspace: { id, role: 'member' } },
    });
    expect(await scope({ 'x-test-user': OWNER, 'x-workspace-id': id })).toEqual({
      status: 200,
      body: { workspace: { id, role: 'owner' } },
    });
  });

  it('refuses a workspace the caller does not belong to', async () => {
    const id = await anOrganization();

    const answer = await scope({ 'x-test-user': OUTSIDER, 'x-workspace-id': id });

    // 403 and no `workspace` at all — not a null scope, which downstream would
    // read as "personal" and serve the caller their own rows under someone
    // else's header.
    expect(answer.status).toBe(403);
    expect(answer.body.workspace).toBeUndefined();
  });

  it('refuses an organization that does not exist, rather than inventing a scope', async () => {
    const answer = await scope({
      'x-test-user': MEMBER,
      'x-workspace-id': '00000000-0000-7000-8000-000000000000',
    });

    expect(answer.status).toBe(403);
  });

  it('demands authentication before it will look anything up', async () => {
    const id = await anOrganization();

    const answer = await scope({ 'x-workspace-id': id });

    expect(answer.status).toBe(401);
  });
});
