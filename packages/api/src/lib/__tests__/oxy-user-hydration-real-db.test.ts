import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Reading an Oxy-owned author off a local row, against a REAL MongoDB.
 *
 * These queries used `.populate()` on a field declared `ref: 'User'` — a model
 * this service does not register and never will, because Oxy owns identity.
 * Mongoose answers that with `MissingSchemaError`, and the reason the fault
 * reached production is the reason this file has to use a real server:
 *
 *   **the throw only happens when there is at least one document to populate.**
 *
 * With an empty result set Mongoose never resolves the ref and the query
 * succeeds, so a fresh organization and an unreviewed agent both worked. A
 * mocked model cannot express any of this — a mocked `find()` returns whatever
 * it was told to and resolves no refs at all, so the bug was invisible to every
 * mocked test and would be invisible to a mocked regression test too.
 *
 * The EMPTY case is asserted alongside the non-empty one deliberately. It is the
 * case that always passed, and a regression test that only covered it would be
 * green against the original bug.
 */

const uri = process.env.ALIA_TEST_MONGODB_URI;

const getUsersByIds = vi.fn();
vi.mock('../../middleware/auth.js', () => ({
  oxyClient: {
    getUsersByIds: (ids: string[]) => getUsersByIds(ids),
  },
}));

const { OrganizationMember } = await import('../../models/organization-member.js');
const { AgentReview } = await import('../../models/agent-review.js');
const { hydrateOxyUsers } = await import('../oxy-user-hydration.js');

beforeAll(async () => {
  if (!uri) throw new Error('ALIA_TEST_MONGODB_URI is not set; vitest.globalSetup.ts must run.');
  await mongoose.connect(uri, { dbName: 'alia-oxy-hydration-test' });
});

afterEach(async () => {
  getUsersByIds.mockReset();
  await Promise.all([OrganizationMember.deleteMany({}), AgentReview.deleteMany({})]);
});

afterAll(async () => {
  await mongoose.disconnect();
});

/**
 * The probe that found the bug, kept as a test. If somebody reintroduces
 * `.populate('oxyUserId', …)` on either query, this is what goes red — and it
 * only can because the fixture is NON-EMPTY.
 */
describe('an Oxy-owned author is read without a Mongoose join', () => {
  it('User is not a registered model, which is what makes the rest meaningful', () => {
    // Vacuity floor: if this ever becomes false the suite below proves nothing,
    // because a registered User would let `.populate()` succeed.
    expect(mongoose.modelNames()).not.toContain('User');
    expect(mongoose.modelNames()).toContain('OrganizationMember');
  });

  it('lists members of a NON-EMPTY organization and hydrates the author', async () => {
    const organizationId = new mongoose.Types.ObjectId();
    const oxyUserId = new mongoose.Types.ObjectId();
    await OrganizationMember.create({ organizationId, oxyUserId, role: 'member' });

    getUsersByIds.mockResolvedValue([
      {
        id: oxyUserId.toHexString(),
        username: 'ada',
        name: { displayName: 'Ada Lovelace' },
        avatar: 'file-1',
      },
    ]);

    const rows = await OrganizationMember.find({ organizationId }).lean();
    const profiles = await hydrateOxyUsers(rows.map((m) => m.oxyUserId?.toString()));

    expect(rows).toHaveLength(1);
    expect(profiles.get(oxyUserId.toHexString())).toEqual({
      _id: oxyUserId.toHexString(),
      username: 'ada',
      displayName: 'Ada Lovelace',
      avatar: 'file-1',
    });
    // One round trip for the page, not one per row.
    expect(getUsersByIds).toHaveBeenCalledTimes(1);
  });

  it('lists reviews of a NON-EMPTY agent without throwing MissingSchemaError', async () => {
    const agentId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    await AgentReview.create({ agentId, userId, rating: 5, comment: 'good' });
    getUsersByIds.mockResolvedValue([]);

    // `.lean()` is its own code path through Mongoose and threw too.
    const rows = await AgentReview.find({ agentId }).lean();
    await expect(hydrateOxyUsers(rows.map((r) => r.userId?.toString()))).resolves.toBeInstanceOf(Map);
    expect(rows).toHaveLength(1);
  });

  it('deduplicates ids so one author reviewed twice costs one lookup', async () => {
    const userId = new mongoose.Types.ObjectId().toHexString();
    getUsersByIds.mockResolvedValue([]);

    await hydrateOxyUsers([userId, userId, null, undefined, '']);

    expect(getUsersByIds).toHaveBeenCalledWith([userId]);
  });

  it('makes no request at all when there is nobody to resolve', async () => {
    const resolved = await hydrateOxyUsers([]);

    expect(resolved.size).toBe(0);
    expect(getUsersByIds).not.toHaveBeenCalled();
  });

  it('falls back to the handle when Oxy resolved no display name', async () => {
    const id = new mongoose.Types.ObjectId().toHexString();
    getUsersByIds.mockResolvedValue([{ id, username: 'grace', name: {} }]);

    const resolved = await hydrateOxyUsers([id]);

    // The sanctioned coalesce — never a name recomposed from first/last/full.
    expect(resolved.get(id)?.displayName).toBe('grace');
  });

  it('FAILS OPEN: an Oxy outage leaves the rows readable', async () => {
    const agentId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    await AgentReview.create({ agentId, userId, rating: 4 });
    getUsersByIds.mockRejectedValue(new Error('oxy is unreachable'));

    const rows = await AgentReview.find({ agentId }).lean();
    const profiles = await hydrateOxyUsers(rows.map((r) => r.userId?.toString()));

    // An identity lookup must not decide whether somebody's reviews render.
    expect(rows).toHaveLength(1);
    expect(profiles.size).toBe(0);
  });
});
