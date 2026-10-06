import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agentOxyAppPermissions } from '../schema/agents';
import { createAgent, deleteAgent } from '../agents/agentRepository';
import {
  deleteAgentOxyAppPermission,
  listAgentOxyAppPermissions,
  upsertAgentOxyAppPermission,
} from '../agents/agentOxyAppPermissionRepository';

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => closePostgres());

async function agent() {
  return createAgent(db, {
    oxyAccountId: `bot-${randomUUID()}`,
    ownerOxyAccountId: 'owner-oxy-apps',
    tagline: 'reads mail',
    description: 'an agent with Oxy app levels',
    authorOxyUserId: 'owner-oxy-apps',
    category: 'assistant',
  });
}

describe('agent_oxy_app_permissions (migration 0083)', () => {
  it('keeps one level per agent and app, replaced in place', async () => {
    const created = await agent();
    await upsertAgentOxyAppPermission(db, { agentId: created._id, appId: 'inbox', level: 'read', oxyGrantId: `g-${randomUUID()}` });
    const grantId = `g-${randomUUID()}`;
    await upsertAgentOxyAppPermission(db, { agentId: created._id, appId: 'inbox', level: 'act', oxyGrantId: grantId });
    await upsertAgentOxyAppPermission(db, { agentId: created._id, appId: 'mention', level: 'read', oxyGrantId: `g-${randomUUID()}` });
    const rows = await listAgentOxyAppPermissions(db, created._id);
    expect(rows.sort((a, b) => a.appId.localeCompare(b.appId))).toEqual([
      { agentId: created._id, appId: 'inbox', level: 'act', oxyGrantId: grantId },
      expect.objectContaining({ appId: 'mention', level: 'read' }),
    ]);
    await deleteAgentOxyAppPermission(db, created._id, 'inbox');
    expect((await listAgentOxyAppPermissions(db, created._id)).map((row) => row.appId)).toEqual(['mention']);
  });

  it('stores only Ver and Ver y actuar — Nada is the absence of a row', async () => {
    const created = await agent();
    await expect(db.execute(sql`
      insert into agent_oxy_app_permissions (agent_id, app_id, level, oxy_grant_id)
      values (${created._id}, 'inbox', 'none', ${`g-${randomUUID()}`})
    `)).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('never lets two levels claim one Oxy grant', async () => {
    const first = await agent();
    const second = await agent();
    const grantId = `g-${randomUUID()}`;
    await upsertAgentOxyAppPermission(db, { agentId: first._id, appId: 'inbox', level: 'read', oxyGrantId: grantId });
    await expect(upsertAgentOxyAppPermission(db, { agentId: second._id, appId: 'inbox', level: 'read', oxyGrantId: grantId }))
      .rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('goes with its agent', async () => {
    const created = await agent();
    await upsertAgentOxyAppPermission(db, { agentId: created._id, appId: 'inbox', level: 'act', oxyGrantId: `g-${randomUUID()}` });
    await deleteAgent(db, created._id);
    expect(await db.select().from(agentOxyAppPermissions).where(eq(agentOxyAppPermissions.agentId, created._id))).toEqual([]);
  });
});
