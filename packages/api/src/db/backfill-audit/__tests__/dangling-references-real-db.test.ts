import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { danglingReferencesCheck, FOREIGN_KEY_REFERENCES } from '../checks/dangling-references';
import { AuditPreconditionError, collectionsRequiredBy, openAuditSource } from '../source';
import { AUDIT_CHECKS } from '../registry';

/**
 * The audit check, against a REAL MongoDB.
 *
 * An audit is the one kind of code whose failure mode is being reassuring, so
 * every case here is paired: seed the violating document and assert the count is
 * NON-ZERO, then seed only clean documents and assert it is ZERO. A check that
 * only ever saw clean data would pass both halves of a one-sided test while
 * being incapable of reporting anything — which is exactly what an audit list
 * accumulates, because nobody ever sees a check fail.
 *
 * A mocked driver cannot express any of this: the whole question is what a real
 * `find({_id: {$in: […]}})` returns for ids that are not there, and a mock
 * returns whatever it was told to.
 */

const uri = process.env.ALIA_TEST_MONGODB_URI;
const DB_NAME = 'alia-backfill-audit-test';

let client: MongoClient;
let db: Db;

beforeAll(async () => {
  if (!uri) throw new Error('ALIA_TEST_MONGODB_URI is not set; vitest.globalSetup.ts must run.');
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(DB_NAME);
  // Every collection the check names must exist for `openAuditSource` to run,
  // and an empty collection is not created by a read.
  for (const name of collectionsRequiredBy(AUDIT_CHECKS)) {
    await db.createCollection(name).catch(() => undefined);
  }
});

afterEach(async () => {
  await Promise.all(
    collectionsRequiredBy(AUDIT_CHECKS).map((name) => db.collection(name).deleteMany({})),
  );
});

afterAll(async () => {
  await db.dropDatabase().catch(() => undefined);
  await client.close();
});

function findingFor(results: Awaited<ReturnType<typeof danglingReferencesCheck.run>>, key: string) {
  const finding = results.findings.find((f) => f.key === key);
  if (!finding) throw new Error(`no finding for ${key}; the declaration list has changed`);
  return finding;
}

describe('the declaration list itself', () => {
  it('names every reference exactly once and covers both array and scalar shapes', () => {
    /**
     * A vacuity floor on the CHECK rather than on the data. If somebody empties
     * or narrows this list, every count below becomes zero and the audit
     * reports a clean run against a database it never looked at properly.
     */
    const keys = FOREIGN_KEY_REFERENCES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThanOrEqual(7);
    expect(FOREIGN_KEY_REFERENCES.some((r) => r.kind === 'array')).toBe(true);
    expect(FOREIGN_KEY_REFERENCES.some((r) => r.kind === 'scalar')).toBe(true);
    // Every declaration names the Postgres constraint that will refuse it, so a
    // reader can go from a number straight to the thing that fails.
    for (const r of FOREIGN_KEY_REFERENCES) expect(r.constraint).toMatch(/_fk$/);
  });
});

describe('an ARRAY reference (agents.skills -> skills)', () => {
  it('COUNTS a dangling id', async () => {
    const liveSkill = new ObjectId();
    const deletedSkill = new ObjectId();
    await db.collection('skills').insertOne({ _id: liveSkill, skillId: 'live' });
    await db.collection('agents').insertOne({
      _id: new ObjectId(),
      name: 'Researcher',
      skills: [liveSkill, deletedSkill],
    });

    const result = await danglingReferencesCheck.run(db);
    const finding = findingFor(result, 'agents.skills');

    expect(finding.count).toBe(1);
    expect(finding.sample).toEqual([String(deletedSkill)]);
    expect(result.documentsScanned).toBeGreaterThan(0);
  });

  it('reports ZERO when every id resolves — the half that proves it can tell them apart', async () => {
    const a = new ObjectId();
    const b = new ObjectId();
    await db.collection('skills').insertMany([
      { _id: a, skillId: 'a' },
      { _id: b, skillId: 'b' },
    ]);
    await db.collection('agents').insertOne({ _id: new ObjectId(), name: 'X', skills: [a, b] });

    const finding = findingFor(await danglingReferencesCheck.run(db), 'agents.skills');
    expect(finding.count).toBe(0);
    expect(finding.sample).toEqual([]);
  });

  it('counts one ROW per (document, dangling id) pair, which is what Postgres refuses', async () => {
    // Two agents referencing the SAME dead skill are two refused rows, not one:
    // `agent_skills` gets a row per pair. A per-dead-target count would
    // under-report the work by exactly the amount that matters.
    const deleted = new ObjectId();
    await db.collection('agents').insertMany([
      { _id: new ObjectId(), name: 'A', skills: [deleted] },
      { _id: new ObjectId(), name: 'B', skills: [deleted] },
    ]);

    const finding = findingFor(await danglingReferencesCheck.run(db), 'agents.skills');
    expect(finding.count).toBe(2);
    // ...while the SAMPLE is of dead targets, so it stays one entry.
    expect(finding.sample).toEqual([String(deleted)]);
  });

  it('does not mistake an empty array for a dangling reference', async () => {
    await db.collection('agents').insertOne({ _id: new ObjectId(), name: 'Empty', skills: [] });
    expect(findingFor(await danglingReferencesCheck.run(db), 'agents.skills').count).toBe(0);
  });
});

describe('a SCALAR reference (agentreviews.agentId -> agents)', () => {
  it('COUNTS a review of a deleted agent', async () => {
    const deletedAgent = new ObjectId();
    await db
      .collection('agentreviews')
      .insertOne({ _id: new ObjectId(), agentId: deletedAgent, rating: 5 });

    const finding = findingFor(await danglingReferencesCheck.run(db), 'agentreviews.agentId');
    expect(finding.count).toBe(1);
    expect(finding.sample).toEqual([String(deletedAgent)]);
  });

  it('reports ZERO when the agent is still there', async () => {
    const agent = new ObjectId();
    await db.collection('agents').insertOne({ _id: agent, name: 'Alive' });
    await db.collection('agentreviews').insertOne({ _id: new ObjectId(), agentId: agent, rating: 4 });

    expect(findingFor(await danglingReferencesCheck.run(db), 'agentreviews.agentId').count).toBe(0);
  });

  it('resolves a target stored as a STRING rather than an ObjectId', async () => {
    /**
     * A raw write around Mongoose can leave a 24-hex string where the schema
     * declares an ObjectId. A query offering only ObjectIds would call such a
     * row dangling while its target is present — a false positive in the
     * direction that wastes an afternoon and makes the whole report suspect.
     */
    const agent = new ObjectId();
    await db.collection('agents').insertOne({ _id: agent, name: 'Alive' });
    await db
      .collection('agentreviews')
      .insertOne({ _id: new ObjectId(), agentId: String(agent), rating: 3 });

    expect(findingFor(await danglingReferencesCheck.run(db), 'agentreviews.agentId').count).toBe(0);
  });
});

describe('the preconditions refuse rather than producing a clean-looking zero', () => {
  it('refuses with no positive control', async () => {
    await expect(
      openAuditSource({
        uri: uri as string,
        databaseName: DB_NAME,
        expectPopulated: [],
        requiredCollections: [],
      }),
    ).rejects.toBeInstanceOf(AuditPreconditionError);
  });

  it('refuses when the positive control is EMPTY — the wrong-database case', async () => {
    // Everything connects, the database exists, and every count would be zero.
    // That is precisely what a clean audit looks like, which is why it fails.
    await expect(
      openAuditSource({
        uri: uri as string,
        databaseName: DB_NAME,
        expectPopulated: ['agents'],
        requiredCollections: [],
      }),
    ).rejects.toThrow(/empty/i);
  });

  it('refuses when a check names a collection that does not exist', async () => {
    await db.collection('agents').insertOne({ _id: new ObjectId(), name: 'seed' });
    await expect(
      openAuditSource({
        uri: uri as string,
        databaseName: DB_NAME,
        expectPopulated: ['agents'],
        requiredCollections: ['agents', 'collection_that_does_not_exist'],
      }),
    ).rejects.toThrow(/do not exist/i);
  });

  it('OPENS when the control is populated and every named collection exists', async () => {
    await db.collection('agents').insertOne({ _id: new ObjectId(), name: 'seed' });
    const source = await openAuditSource({
      uri: uri as string,
      databaseName: DB_NAME,
      expectPopulated: ['agents'],
      requiredCollections: collectionsRequiredBy(AUDIT_CHECKS),
    });
    expect(source.db.databaseName).toBe(DB_NAME);
    await source.close();
  });

  it('refuses a database whose name is not the one asked for', async () => {
    await expect(
      openAuditSource({
        uri: uri as string,
        databaseName: 'alia-development',
        expectPopulated: ['agents'],
        requiredCollections: [],
      }),
      // `alia-development` really exists beside production on the shared host,
      // so this is the case the literal exists to prevent: it connects fine and
      // has nothing this audit is about in it.
    ).rejects.toBeInstanceOf(AuditPreconditionError);
  });
});
