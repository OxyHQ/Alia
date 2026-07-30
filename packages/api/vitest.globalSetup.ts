import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * One MongoDB replica set for the whole suite.
 *
 * A replica SET rather than a standalone, because the two properties the
 * moderation integration rests on only exist there: multi-document transactions
 * (a report and its outbox row commit together, or neither does) and the unique
 * indexes that make a retry idempotent.
 *
 * A mocked model can be made to agree with any of those claims, which is exactly
 * why it must not be the thing they are tested against — a mocked `updateOne`
 * accepts every update document, including ones the server rejects. That is not
 * weak evidence, it is no evidence, and it reads as rigour. It shipped a real
 * bug here: an `$setOnInsert` naming `updatedAt` against a `timestamps: true`
 * schema, which MongoDB refuses outright and which aborted the whole intake
 * transaction. The mocked suite was green throughout.
 */
let replicaSet: MongoMemoryReplSet | null = null;

export async function setup(): Promise<void> {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  process.env.ALIA_TEST_MONGODB_URI = replicaSet.getUri();
}

export async function teardown(): Promise<void> {
  await replicaSet?.stop();
  replicaSet = null;
}
