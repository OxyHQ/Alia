import mongoose, { type Connection } from 'mongoose';

/**
 * Multi-document transactions require a replica set or a sharded cluster.
 *
 * Alia used no transactions at all before this feature, so nothing else in the
 * application would ever notice a standalone `mongod`. It accepts every other
 * write Alia makes and then fails the FIRST time a report and its outbox event try
 * to commit together — which is the moment the outbox stops being able to protect
 * anything.
 *
 * That failure is expensive to diagnose later and free to detect now, so the
 * topology is checked when the integration is switched on rather than discovered
 * at the first report. Mirrors CrowdSource's own `utils/mongoTopology.ts`, which
 * cannot be imported here — its backend is a private package.
 */

interface HelloResponse {
  /** Present on a replica set member. */
  setName?: unknown;
  /** `isdbgrid` on a mongos router. */
  msg?: unknown;
}

/** True when the connected deployment can run multi-document transactions. */
export function supportsTransactions(hello: HelloResponse): boolean {
  const isReplicaSet = typeof hello.setName === 'string' && hello.setName.length > 0;
  const isShardedCluster = hello.msg === 'isdbgrid';
  return isReplicaSet || isShardedCluster;
}

export const STANDALONE_TOPOLOGY_MESSAGE =
  'MongoDB is a standalone deployment, which cannot run multi-document transactions. ' +
  'The moderation outbox requires a report and its delivery event to commit together, ' +
  'so moderation work would be silently lost. Connect to a replica set or a sharded ' +
  "cluster (check with `mongosh --eval 'rs.status().set'`).";

/**
 * Whether this deployment can run the moderation outbox at all.
 *
 * Returns rather than throws, and the caller decides. Alia is an AI platform whose
 * chat surface has nothing to do with moderation, so refusing to boot the whole
 * API over a misconfigured optional integration would trade a contained failure
 * for an outage. The dispatcher logs at error level and stays down instead, and
 * intake still throws per-request — two loud signals, neither of them silent.
 */
export async function assertTransactionalTopology(
  connection: Connection = mongoose.connection,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const database = connection.db;
  if (!database) {
    return {
      ok: false,
      reason: 'Cannot inspect the MongoDB topology before a connection is open.',
    };
  }

  try {
    const hello = (await database.admin().command({ hello: 1 })) as HelloResponse;
    if (supportsTransactions(hello)) return { ok: true };
    return { ok: false, reason: STANDALONE_TOPOLOGY_MESSAGE };
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `Could not inspect the MongoDB topology: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
