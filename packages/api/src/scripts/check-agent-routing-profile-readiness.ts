import { pathToFileURL } from 'node:url';
import { readTargetDatabase } from '@oxyhq/db/migrate';
import { eq } from 'drizzle-orm';
import { OXY_KAANA_ROUTING_PROFILE_ID_LIST } from '../config/oxy-inference-routing-profile-ids.js';
import { assertTargetDatabase } from '../db/assertTargetDatabase.js';
import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import { agents } from '../db/schema/agents.js';

const REVIEWED = new Set<string>(OXY_KAANA_ROUTING_PROFILE_ID_LIST);

export interface AgentRoutingReadinessRow {
  readonly id: string;
  readonly routingProfileId: string | null;
  readonly allowedModels: readonly string[];
}

export function agentRoutingReadinessReport(rows: readonly AgentRoutingReadinessRow[]) {
  const unresolved = rows
    .filter((row) => row.routingProfileId === null || !REVIEWED.has(row.routingProfileId))
    .map((row) => ({
      id: row.id,
      routingProfileId: row.routingProfileId,
      legacyAllowedModels: [...row.allowedModels],
      reason: row.routingProfileId === null ? 'missing' as const : 'unknown' as const,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { ready: unresolved.length === 0, unresolvedCount: unresolved.length, unresolved };
}

async function main(): Promise<void> {
  const expectedDatabase = readTargetDatabase(process.argv.slice(2));
  if (!connectPostgres(process.env.DATABASE_URL)) throw new Error('DATABASE_URL is required');
  await assertTargetDatabase(expectedDatabase);
  const rows = await getDb()
    .select({
      id: agents.id,
      routingProfileId: agents.routingProfileId,
      allowedModels: agents.allowedModels,
    })
    .from(agents)
    .where(eq(agents.status, 'active'));
  const report = agentRoutingReadinessReport(rows);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ready) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(closePostgres);
}
