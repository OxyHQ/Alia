import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import { createTestDatabase, dropTestDatabase } from '@oxy.so/db/testing';
import { runMigrations } from '@oxy.so/db/migrate';
import { expect, it } from 'vitest';
const execute = promisify(execFile);
const packageRoot = join(__dirname, '../../..');
async function through(url: string, last: string, run: 'pre' | 'post' | 'all') {
  const original = join(packageRoot, 'drizzle');
  const journal = JSON.parse(readFileSync(join(original, 'meta/_journal.json'), 'utf8'));
  const end = journal.entries.findIndex((entry: { tag: string }) => entry.tag === last);
  if (end < 0) throw new Error('Missing migration');
  const entries: { tag: string }[] = journal.entries.slice(0, end + 1);
  const folder = mkdtempSync(join(tmpdir(), 'alia-org-migrations-'));
  try {
    mkdirSync(join(folder, 'meta'));
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const entry of entries)
      copyFileSync(join(original, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    await runMigrations({
      databaseUrl: url,
      migrationsFolder: folder,
      extensions: [],
      run,
      expectedDatabase: new URL(url).pathname.slice(1),
      dryRun: false,
      logger: { info: () => undefined, debug: () => undefined },
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
it('archives a populated workspace, freezes former authority, requires mapping, and preserves all domain records across pre/backfill/post', async () => {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) throw new Error('TEST_DATABASE_URL required');
  const url = await createTestDatabase({
    adminUrl,
    migrate: (target) => through(target, '0093_drop_message_audio_url', 'all'),
  });
  const db = postgres(url, { max: 1, onnotice: () => undefined });
  const folder = mkdtempSync(join(tmpdir(), 'alia-org-plan-'));
  let upstream: Server | undefined;
  try {
    await db`insert into organizations(id,name,slug,description,image,owner_id,credits_paid,stripe_customer_id,settings_billing_email,settings_api_call_limit) values ('historical','Old name','historical-url','Old description','old-logo','old-local-owner',92,'cus_history','finance@example.com',75)`;
    await db`insert into organization_members(id,organization_id,oxy_user_id,role) values ('historical-member','historical','old-local-owner','owner')`;
    await db`insert into organization_invites(id,organization_id,role,token,invited_by,expires_at) values ('historical-invite','historical','admin','reusable-secret','old-local-owner',now()+interval '7 days')`;
    await db`insert into organization_agents(id,organization_id,agent_id,added_by) values ('historical-share','historical','historical-agent','old-local-owner')`;
    await through(url, '0097_retire_local_organization_identity', 'pre');
    await expect(
      db`update organizations set name='Local edit' where id='historical'`,
    ).rejects.toThrow('managed in Oxy');
    await expect(
      db`insert into organizations(id,name,slug,owner_id) values ('old-writer','Local company','old-writer','person')`,
    ).rejects.toThrow('retired');
    await db`insert into organizations(id,slug,oxy_account_id) values ('new-reference','new-reference','oxy-new')`;
    await expect(
      db`update organization_members set role='admin' where id='historical-member'`,
    ).rejects.toThrow('immutable');
    await expect(
      db`update organization_invites set status='accepted' where id='historical-invite'`,
    ).rejects.toThrow('immutable');
    await expect(through(url, '0097_retire_local_organization_identity', 'post')).rejects.toThrow(
      'reviewed canonical mappings',
    );
    expect(await db`select name from organizations where id='historical'`).toEqual([
      { name: 'Old name' },
    ]);
    const target = new URL(url).pathname.slice(1);
    await execute('bun', ['build.ts'], { cwd: packageRoot });
    const script = join(packageRoot, 'dist/scripts/backfill-workspace-organizations.js');
    const mapping = join(folder, 'mappings.json');
    const plan = join(folder, 'plan.json');
    writeFileSync(
      mapping,
      JSON.stringify([
        {
          workspaceId: 'historical',
          accountId: 'oxy-canonical',
          evidenceReference: 'review:source-application-owner',
        },
      ]),
    );
    const env = { ...process.env, DATABASE_URL: url };
    await execute(
      'bun',
      [
        script,
        `--target-database=${target}`,
        `--reviewed-mappings=${mapping}`,
        `--plan-output=${plan}`,
      ],
      { env },
    );
    const prepared = JSON.parse(readFileSync(plan, 'utf8'));
    expect(prepared.records[0]).toMatchObject({
      id: 'historical',
      credits_paid: 92,
      members: 1,
      invites: 1,
      agents: 1,
    });
    expect(readFileSync(plan, 'utf8')).not.toContain('reusable-secret');
    expect(statSync(plan).mode & 0o777).toBe(0o600);
    await expect(
      execute('bun', [script, `--target-database=${target}`, '--apply', '--plan-sha256=stale'], {
        env,
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('Plan changed') });
    const requests: unknown[] = [];
    upstream = createServer(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(part);
      requests.push(JSON.parse(Buffer.concat(parts).toString()));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ accountId: 'oxy-canonical', created: false }));
    });
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing socket');
    const token = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"staff","exp":4102444800}').toString('base64url')}.unsigned`;
    await execute(
      'bun',
      [
        script,
        `--target-database=${target}`,
        `--reviewed-mappings=${mapping}`,
        '--apply',
        `--plan-sha256=${prepared.sha256}`,
      ],
      {
        env: {
          ...env,
          OXY_ADMIN_ACCESS_TOKEN: token,
          OXY_API_URL: `http://127.0.0.1:${address.port}`,
        },
      },
    );
    expect(requests).toEqual([
      {
        namespace: 'alia',
        externalId: 'historical',
        accountId: 'oxy-canonical',
        organization: { name: 'Old name', organizationType: 'other' },
        evidenceReference: 'review:source-application-owner',
      },
    ]);
    await through(url, '0097_retire_local_organization_identity', 'post');
    expect(
      await db`select id,slug,oxy_account_id,credits_paid,stripe_customer_id,settings_billing_email,settings_api_call_limit from organizations where id='historical'`,
    ).toEqual([
      {
        id: 'historical',
        slug: 'historical-url',
        oxy_account_id: 'oxy-canonical',
        credits_paid: 92,
        stripe_customer_id: 'cus_history',
        settings_billing_email: 'finance@example.com',
        settings_api_call_limit: 75,
      },
    ]);
    expect(
      await db`select organization_id,name,owner_id,image from organization_identity_archives`,
    ).toEqual([
      {
        organization_id: 'historical',
        name: 'Old name',
        owner_id: 'old-local-owner',
        image: 'old-logo',
      },
    ]);
    expect(await db`select id,role from organization_members`).toEqual([
      { id: 'historical-member', role: 'owner' },
    ]);
    expect(await db`select id,organization_id,agent_id from organization_agents`).toEqual([
      { id: 'historical-share', organization_id: 'historical', agent_id: 'historical-agent' },
    ]);
    expect(await db`select id,status from organization_invites`).toEqual([
      { id: 'historical-invite', status: 'pending' },
    ]);
    expect(
      await db`select column_name from information_schema.columns where table_name='organization_invites' and column_name='token'`,
    ).toEqual([]);
    await expect(db`delete from organization_identity_archives`).rejects.toThrow('immutable');
    // Evidence-based dry runs remain usable after post has removed serving identity fields.
    const after = await execute('bun', [script, `--target-database=${target}`], { env });
    expect(JSON.parse(after.stdout).unmapped).toBe(0);
  } finally {
    if (upstream)
      await new Promise<void>((resolve, reject) =>
        upstream!.close((e) => (e ? reject(e) : resolve())),
      );
    await db.end();
    await dropTestDatabase(url);
    rmSync(folder, { recursive: true, force: true });
  }
}, 30000);
