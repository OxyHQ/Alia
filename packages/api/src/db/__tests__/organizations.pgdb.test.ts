import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { isUniqueViolation } from '@oxy.so/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { organizations } from '../schema/organizations';
let db: ApiDatabase;
beforeAll(() => {
  const connection = connectPostgres(process.env.DATABASE_URL);
  if (!connection) throw new Error('Postgres required');
  db = connection;
});
afterAll(closePostgres);
describe('canonical workspace constraints', () => {
  it('preserves case-insensitive historical slugs and one workspace per Oxy organization', async () => {
    await db
      .insert(organizations)
      .values({ id: 'schema-org-a', oxyAccountId: 'schema-canonical-a', slug: 'Historic' });
    await expect(
      db
        .insert(organizations)
        .values({ id: 'schema-org-b', oxyAccountId: 'schema-canonical-b', slug: 'HISTORIC' }),
    ).rejects.toSatisfy(isUniqueViolation);
    await expect(
      db
        .insert(organizations)
        .values({ id: 'schema-org-c', oxyAccountId: 'schema-canonical-a', slug: 'Other' }),
    ).rejects.toSatisfy(isUniqueViolation);
  });
  it('refuses reference reassignment and all retired membership/invitation writes even with zero matching rows', async () => {
    await expect(
      db.execute(sql`update organizations set oxy_account_id='different' where id='schema-org-a'`),
    ).rejects.toMatchObject({
      cause: { message: expect.stringContaining('cannot be reassigned') },
    });
    for (const table of [
      'organization_members',
      'organization_invites',
      'organization_identity_archives',
    ]) {
      await expect(db.execute(sql.raw(`delete from ${table} where false`))).rejects.toMatchObject({
        cause: { message: expect.stringContaining('immutable') },
      });
      await expect(db.execute(sql.raw(`truncate ${table}`))).rejects.toMatchObject({
        cause: { message: expect.stringContaining('immutable') },
      });
    }
  });
  it('has no serving local identity or reusable invitation token columns', async () => {
    const rows = await db.execute<{ table_name: string; column_name: string }>(
      sql`select table_name,column_name from information_schema.columns where table_schema='public' and table_name in ('organizations','organization_invites')`,
    );
    for (const column of ['name', 'owner_id', 'image', 'description'])
      expect(
        rows.filter((r) => r.table_name === 'organizations').map((r) => r.column_name),
      ).not.toContain(column);
    expect(rows.some((r) => r.column_name === 'token')).toBe(false);
  });
});
