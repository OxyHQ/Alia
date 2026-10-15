import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { organizations } from '../schema/organizations';
import {
  createOrganization,
  findOrganizationById,
  listOrganizationsForAccounts,
  updateOrganization,
  shareAgentWithOrganization,
  listSharedAgentIds,
  unshareAgentFromOrganization,
} from '../organizations/organizationRepository';
let db: ApiDatabase;
beforeAll(() => {
  const connection = connectPostgres(process.env.DATABASE_URL);
  if (!connection) throw new Error('Postgres required');
  db = connection;
});
afterAll(closePostgres);
describe('workspace state without local identity or authority', () => {
  it('creates an Oxy reference and lists only selected accounts, deduplicating across batches', async () => {
    const a = await createOrganization(db, 'repo-canonical-a');
    const b = await createOrganization(db, 'repo-canonical-b');
    expect(await findOrganizationById(db, a.id)).toEqual(a);
    const rows = await listOrganizationsForAccounts(db, [
      ...Array(101).fill('repo-canonical-a'),
      'repo-canonical-b',
    ]);
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(await listOrganizationsForAccounts(db, [])).toEqual([]);
    expect(await listOrganizationsForAccounts(db, ['unknown'])).toEqual([]);
  });
  it('merges settings without rewriting omitted fields, credits, customer, or stable slug', async () => {
    const row = await createOrganization(db, 'repo-canonical-settings');
    await db
      .update(organizations)
      .set({ creditsPaid: 275, stripeCustomerId: 'cus_historical', settingsApiCallLimit: 30 })
      .where(eq(organizations.id, row.id));
    const updated = await updateOrganization(db, row.id, { billingEmail: 'billing@example.com' });
    expect(updated).toMatchObject({
      creditsPaid: 275,
      stripeCustomerId: 'cus_historical',
      settingsApiCallLimit: 30,
      settingsBillingEmail: 'billing@example.com',
      slug: row.slug,
    });
    expect(await updateOrganization(db, 'missing', { apiCallLimit: 5 })).toBeNull();
  });
  it('keeps shared agent references idempotent and scoped to a workspace', async () => {
    const a = await createOrganization(db, 'repo-canonical-share-a');
    const b = await createOrganization(db, 'repo-canonical-share-b');
    await shareAgentWithOrganization(db, a.id, 'bot-a', 'person-a');
    await shareAgentWithOrganization(db, a.id, 'bot-a', 'person-b');
    await shareAgentWithOrganization(db, b.id, 'bot-a', 'person-a');
    expect(await listSharedAgentIds(db, a.id)).toEqual(['bot-a']);
    expect(await unshareAgentFromOrganization(db, a.id, 'bot-a')).toBe(true);
    expect(await unshareAgentFromOrganization(db, a.id, 'bot-a')).toBe(false);
    expect(await listSharedAgentIds(db, b.id)).toEqual(['bot-a']);
  });
});
