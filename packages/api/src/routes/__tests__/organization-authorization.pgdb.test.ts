/**
 * Who may do what inside an organization, driven as real HTTP against the real
 * router and a real Postgres.
 *
 * ## Why this is a route test and not a repository test
 *
 * The authorization matrix lives in `routes/organization.ts`. The repository
 * answers one question — "what is this account's role here" — and every gate is
 * the ROUTE comparing that answer against a set: any member may read, an
 * owner-or-admin may administer, only the owner may delete the organization or
 * change a role. A repository test cannot see a route that asks the wrong
 * question, and the wrong question is the whole failure: an `admin` who can
 * delete the organization, or a `member` who can revoke invitations, is a
 * privilege escalation that returns 200 and looks like a working feature.
 *
 * The router is MOUNTED rather than its handlers imported, so a path registered
 * above it would be seen here. It is driven over a socket for the same reason.
 *
 * ## The database is real
 *
 * The gates read `organization_members`, so a mocked repository would be a test
 * of the mock's role table. The rows are seeded through the same repository the
 * routes use, and torn down by id — the pg suite shares ONE database across
 * files running in parallel, so a blanket delete here would wipe a sibling's
 * fixtures.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The authenticated account is whatever `x-test-user` says.
 *
 * Mocked at the middleware module rather than by minting a real Oxy token: what
 * is under test is the role comparison, and a real token would make every
 * assertion depend on an identity service being reachable. `oxyClient` is
 * mocked in the same factory because `lib/oxy-user-hydration.ts` reads it from
 * here, and the member-list routes call it.
 */
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction) => {
    const id = req.headers['x-test-user'];
    if (typeof id === 'string' && id !== '') req.user = { id };
    next();
  },
  oxyClient: { getUsersByIds: () => Promise.resolve([]) },
}));

const { closePostgres, connectPostgres } = await import('../../db/index.js');
const {
  createInvite,
  createOrganization,
  findMemberRole,
  findOrganizationById,
} = await import('../../db/organizations/organizationRepository.js');
const { organizationMembers, organizations } = await import('../../db/schema/organizations.js');
const organizationRouter = (await import('../organization.js')).default;
const { log } = await import('../../lib/logger.js');

type Db = ReturnType<typeof connectPostgres>;

let db: NonNullable<Db>;
let base: string;
let server: Server;

const OWNER = 'orgauth-owner';
const ADMIN = 'orgauth-admin';
const MEMBER = 'orgauth-member';
const OUTSIDER = 'orgauth-outsider';

const created: string[] = [];

beforeAll(async () => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;

  // The 404 and 403 paths are the expected outcome here, and each one the router
  // catches is a stack trace on every CI run. Only this file's registry is
  // touched — vitest isolates module registries per file.
  vi.spyOn(log.organization, 'error').mockImplementation(() => undefined);
  vi.spyOn(log.organization, 'info').mockImplementation(() => undefined);

  const app: Express = express();
  app.use(express.json());
  app.use('/organization', organizationRouter);
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await closePostgres();
});

afterEach(async () => {
  if (created.length === 0) return;
  await db.delete(organizations).where(inArray(organizations.id, [...created]));
  created.length = 0;
});

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function call(
  method: string,
  path: string,
  as: string | null,
  body?: unknown,
): Promise<Answer> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(as === null ? {} : { 'x-test-user': as }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

let slugCounter = 0;

/** An organization with an owner, an admin and an ordinary member. */
async function aStaffedOrganization(): Promise<string> {
  slugCounter += 1;
  const organization = await createOrganization(db, {
    name: 'Acme',
    slug: `orgauth-slug-${String(slugCounter)}`,
    ownerId: OWNER,
  });
  if (!organization) throw new Error('fixture organization was refused');
  created.push(organization.id);
  await db.insert(organizationMembers).values([
    { organizationId: organization.id, oxyUserId: ADMIN, role: 'admin' },
    { organizationId: organization.id, oxyUserId: MEMBER, role: 'member' },
  ]);
  return organization.id;
}

describe('reading an organization requires membership, of any role', () => {
  it('serves every member and refuses everyone else', async () => {
    const id = await aStaffedOrganization();

    for (const account of [OWNER, ADMIN, MEMBER]) {
      expect((await call('GET', `/organization/${id}`, account)).status, account).toBe(200);
      expect((await call('GET', `/organization/${id}/members`, account)).status, account).toBe(200);
      expect((await call('GET', `/organization/${id}/agents`, account)).status, account).toBe(200);
    }

    // 403, not 404: the caller learns nothing about whether the organization
    // exists, which is the same answer the Mongo routes gave.
    expect((await call('GET', `/organization/${id}`, OUTSIDER)).status).toBe(403);
    expect((await call('GET', `/organization/${id}/members`, OUTSIDER)).status).toBe(403);
    expect((await call('GET', `/organization/${id}/agents`, OUTSIDER)).status).toBe(403);
  });

  it('lists only the caller own organizations', async () => {
    const id = await aStaffedOrganization();

    const mine = await call('GET', '/organization', MEMBER);
    const theirs = await call('GET', '/organization', OUTSIDER);

    const listed = (mine.body.organizations as { _id: string }[]).map((o) => o._id);
    expect(listed).toContain(id);
    expect((theirs.body.organizations as { _id: string }[]).map((o) => o._id)).not.toContain(id);
  });

  it('serves the nested credits and settings the console reads', async () => {
    // `use-workspace.ts` reads `org.credits?.paid ?? 0` and `org._id`. A flat row
    // renders every balance as zero and makes `org._id === other._id` true for
    // every pair — both silent.
    const id = await aStaffedOrganization();

    const answer = await call('GET', '/organization', OWNER);
    const listed = (answer.body.organizations as Record<string, unknown>[]).find(
      (o) => o._id === id,
    );

    expect(listed?._id).toBe(id);
    expect(listed?.credits).toEqual({ paid: 0 });
    expect(listed?.settings).toEqual({ billingEmail: null, apiCallLimit: null });
    expect(listed?.role).toBe('owner');
    expect(listed?.memberCount).toBe(3);
  });
});

describe('administering an organization requires owner or admin', () => {
  it('lets an admin update it, and refuses an ordinary member', async () => {
    const id = await aStaffedOrganization();

    expect((await call('PATCH', `/organization/${id}`, ADMIN, { name: 'Renamed' })).status).toBe(200);
    expect((await call('PATCH', `/organization/${id}`, MEMBER, { name: 'Nope' })).status).toBe(403);
    expect((await call('PATCH', `/organization/${id}`, OUTSIDER, { name: 'Nope' })).status).toBe(403);

    expect((await findOrganizationById(db, id))?.name).toBe('Renamed');
  });

  it('lets an admin issue and list invitations, and refuses a member', async () => {
    const id = await aStaffedOrganization();

    const issued = await call('POST', `/organization/${id}/members`, ADMIN, { role: 'member' });
    expect(issued.status).toBe(201);
    const invite = issued.body.invite as Record<string, unknown>;
    // The console reads `_id`, `token` and `inviteUrl` off exactly this shape.
    expect(typeof invite._id).toBe('string');
    expect(typeof invite.token).toBe('string');
    expect(invite.inviteUrl).toContain(String(invite.token));

    const listed = await call('GET', `/organization/${id}/invites`, ADMIN);
    expect(listed.status).toBe(200);
    const rows = listed.body.invites as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    // The list identifies the invitation — `_id` is what a revoke names — and
    // does NOT carry the token. That token is a live join-link for the whole
    // organization; the create response above is the one place it is handed out.
    expect(rows[0]?._id).toBe(invite._id);
    expect(rows[0]).not.toHaveProperty('token');

    expect((await call('POST', `/organization/${id}/members`, MEMBER, { role: 'member' })).status).toBe(403);
    expect((await call('GET', `/organization/${id}/invites`, MEMBER)).status).toBe(403);
  });

  it('refuses an invitation offering OWNERSHIP, whoever asks', async () => {
    // The role set is narrower than the membership one by design: an invitation
    // cannot mint an owner. Refused by the schema too, but this is the route
    // saying no before a row is attempted.
    const id = await aStaffedOrganization();

    const answer = await call('POST', `/organization/${id}/members`, OWNER, { role: 'owner' });

    expect(answer.status).toBe(400);
  });
});

describe('only the owner may delete the organization or change a role', () => {
  it('refuses an ADMIN, which is the escalation worth naming', async () => {
    const id = await aStaffedOrganization();

    expect((await call('DELETE', `/organization/${id}`, ADMIN)).status).toBe(403);
    expect(await findOrganizationById(db, id)).not.toBeNull();
  });

  it('refuses an admin changing a role, and lets the owner do it', async () => {
    const id = await aStaffedOrganization();
    const members = (await call('GET', `/organization/${id}/members`, OWNER)).body
      .members as { _id: string; role: string; oxyUserId: string }[];
    const target = members.find((m) => m.oxyUserId === MEMBER);
    if (!target) throw new Error('the fixture member is missing from the list');

    expect((await call('PATCH', `/organization/${id}/members/${target._id}`, ADMIN, { role: 'admin' })).status).toBe(403);
    expect(await findMemberRole(db, id, MEMBER)).toBe('member');

    expect((await call('PATCH', `/organization/${id}/members/${target._id}`, OWNER, { role: 'admin' })).status).toBe(200);
    expect(await findMemberRole(db, id, MEMBER)).toBe('admin');
  });

  it('lets the owner delete it', async () => {
    // The positive control: without it every refusal above passes on a route
    // that refuses everybody.
    const id = await aStaffedOrganization();

    expect((await call('DELETE', `/organization/${id}`, OWNER)).status).toBe(200);
    expect(await findOrganizationById(db, id)).toBeNull();
  });
});

describe('removing a member', () => {
  it('lets an admin remove an ordinary member but never the owner', async () => {
    const id = await aStaffedOrganization();
    const members = (await call('GET', `/organization/${id}/members`, OWNER)).body
      .members as { _id: string; oxyUserId: string }[];
    const ordinary = members.find((m) => m.oxyUserId === MEMBER);
    const owner = members.find((m) => m.oxyUserId === OWNER);
    if (!ordinary || !owner) throw new Error('the fixture membership is incomplete');

    expect((await call('DELETE', `/organization/${id}/members/${owner._id}`, ADMIN)).status).toBe(400);
    expect(await findMemberRole(db, id, OWNER)).toBe('owner');

    expect((await call('DELETE', `/organization/${id}/members/${ordinary._id}`, ADMIN)).status).toBe(200);
    expect(await findMemberRole(db, id, MEMBER)).toBeNull();
  });

  it('refuses a member id belonging to ANOTHER organization', async () => {
    /**
     * The cross-tenant write the Mongo route allowed: it checked that the caller
     * administered the organization in the URL and then looked the member up by
     * id alone. End to end, because the fix has to hold at the route the request
     * actually reaches.
     */
    const mine = await aStaffedOrganization();
    const theirs = await aStaffedOrganization();
    const theirMembers = (await call('GET', `/organization/${theirs}/members`, OWNER)).body
      .members as { _id: string; oxyUserId: string }[];
    const victim = theirMembers.find((m) => m.oxyUserId === MEMBER);
    if (!victim) throw new Error('the second organization has no ordinary member');

    expect((await call('DELETE', `/organization/${mine}/members/${victim._id}`, OWNER)).status).toBe(404);
    expect((await call('PATCH', `/organization/${mine}/members/${victim._id}`, OWNER, { role: 'admin' })).status).toBe(404);

    expect(await findMemberRole(db, theirs, MEMBER)).toBe('member');
  });
});

describe('an invitation link is redeemable by whoever holds it', () => {
  it('previews, accepts once, and refuses the replay', async () => {
    const id = await aStaffedOrganization();
    const invite = await createInvite(db, {
      organizationId: id,
      role: 'admin',
      token: 'orgauth-token-flow',
      invitedBy: OWNER,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(invite.token).toBe('orgauth-token-flow');

    const info = await call('GET', '/organization/invites/orgauth-token-flow/info', OUTSIDER);
    expect(info.status).toBe(200);
    const preview = info.body.invite as { organization: Record<string, unknown> };
    // The projection the Mongo `.populate('organizationId', 'name slug image')`
    // served, and no more: anyone holding a token reaches this endpoint.
    expect(Object.keys(preview.organization).sort()).toEqual(['_id', 'image', 'name', 'slug']);

    const accepted = await call('POST', '/organization/invites/orgauth-token-flow/accept', OUTSIDER);
    expect(accepted.status).toBe(200);
    expect(await findMemberRole(db, id, OUTSIDER)).toBe('admin');

    // Single-use: the second redemption of the same link finds nothing.
    const replay = await call('POST', '/organization/invites/orgauth-token-flow/accept', 'orgauth-stranger');
    expect(replay.status).toBe(404);
    expect(await findMemberRole(db, id, 'orgauth-stranger')).toBeNull();
  });

  it('answers 400 when the holder is already a member', async () => {
    const id = await aStaffedOrganization();
    await createInvite(db, {
      organizationId: id,
      role: 'admin',
      token: 'orgauth-token-dup',
      invitedBy: OWNER,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const answer = await call('POST', '/organization/invites/orgauth-token-dup/accept', MEMBER);

    expect(answer.status).toBe(400);
    // Not upgraded to the invited role by a link they did not need.
    expect(await findMemberRole(db, id, MEMBER)).toBe('member');
  });
});
