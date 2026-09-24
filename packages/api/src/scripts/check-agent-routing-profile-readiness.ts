import { inspect } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readTargetDatabase } from '@oxy.so/db/migrate';
import { eq } from 'drizzle-orm';
import { OXY_KAANA_ROUTING_PROFILE_ID_LIST, OXY_KAANA_SPEECH_ROUTING_PROFILE_ID } from '../config/oxy-inference-routing-profile-ids.js';
import { assertTargetDatabase } from '../db/assertTargetDatabase.js';
import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import { agents } from '../db/schema/agents.js';
import { getOxyInferenceClient } from '../lib/inference/oxy-inference.js';

const REVIEWED = new Set<string>(OXY_KAANA_ROUTING_PROFILE_ID_LIST);

export interface AgentRoutingReadinessRow {
  readonly id: string;
  readonly routingProfileId: string | null;
}

export function agentRoutingReadinessReport(rows: readonly AgentRoutingReadinessRow[]) {
  const unresolved = rows
    .filter((row) => row.routingProfileId === null || !REVIEWED.has(row.routingProfileId))
    .map((row) => ({
      id: row.id,
      routingProfileId: row.routingProfileId,
      reason: row.routingProfileId === null ? 'missing' as const : 'unknown' as const,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { ready: unresolved.length === 0, unresolvedCount: unresolved.length, unresolved };
}

/**
 * Every Oxy profile this image names at call time: the chat and agent profiles
 * resolved per turn, and the speech-only profile `lib/synthesize-speech.ts`
 * names on every read-aloud and voice answer.
 *
 * Speech was reported-not-blocking while Oxy had not provisioned it (#576
 * blocked every deploy on a capability Alia could not create). Oxy provisioned
 * it on 2026-09-24 (OxyHQ/oxy #1360, bootstrap run 36055026625), so it is a
 * required profile again: a missing one now means read-aloud fails, which is
 * worth refusing to deploy over.
 */
export const REQUIRED_OXY_ROUTING_PROFILE_IDS: readonly string[] = [
  ...OXY_KAANA_ROUTING_PROFILE_ID_LIST,
  OXY_KAANA_SPEECH_ROUTING_PROFILE_ID,
];

/** Compare against what the authenticated Alia application can actually see in
 * Oxy. Source constants alone cannot prove that the reviewed bootstrap ran. */
export function oxyRoutingReadinessReport(routingProfileIds: readonly string[]) {
  const visible = new Set(routingProfileIds);
  const missing = REQUIRED_OXY_ROUTING_PROFILE_IDS.filter((id) => !visible.has(id));
  return { ready: missing.length === 0, missingCount: missing.length, missing };
}

async function main(): Promise<void> {
  const expectedDatabase = readTargetDatabase(process.argv.slice(2));
  if (!connectPostgres(process.env.DATABASE_URL)) throw new Error('DATABASE_URL is required');
  await assertTargetDatabase(expectedDatabase);
  const rows = await getDb()
    .select({
      id: agents.id,
      routingProfileId: agents.routingProfileId,
    })
    .from(agents)
    .where(eq(agents.status, 'active'));
  const agentsReport = agentRoutingReadinessReport(rows);
  const client = getOxyInferenceClient();
  if (client === null) throw new Error('Oxy inference client is not configured');
  const profiles = await client.listRoutingProfiles({ signal: AbortSignal.timeout(10_000) });
  const visibleIds = profiles.map((profile) => profile.routingProfileId);
  const oxyReport = oxyRoutingReadinessReport(visibleIds);
  const report = { ready: agentsReport.ready && oxyReport.ready, agents: agentsReport, oxy: oxyReport };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ready) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error: unknown) => {
      // `inspect`, not `String()`: a dependency can reject with a plain object,
      // and `String()` of one printed only `[object Object]` for the readiness
      // failure of 2026-09-24, hiding which dependency refused and why.
      process.stderr.write(`${error instanceof Error ? error.message : inspect(error, { depth: 4 })}\n`);
      process.exitCode = 1;
    })
    .finally(closePostgres);
}
