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

/** Compare against what the authenticated Alia application can actually see in
 * Oxy. Source constants alone cannot prove that the reviewed bootstrap ran.
 *
 * CHAT AND AGENT PROFILES ONLY, and that boundary is the point. Every one of
 * these is resolved per turn by the runtime this deploy is shipping, so a
 * missing one means the next conversation fails — worth refusing to deploy
 * over. The speech profile is not in that set; see {@link speechReadinessReport}. */
export function oxyRoutingReadinessReport(routingProfileIds: readonly string[]) {
  const visible = new Set(routingProfileIds);
  const missing = OXY_KAANA_ROUTING_PROFILE_ID_LIST.filter((id) => !visible.has(id));
  return { ready: missing.length === 0, missingCount: missing.length, missing };
}

/**
 * Whether Oxy has provisioned the speech-only profile yet. REPORTED, NOT BLOCKING.
 *
 * This assertion used to sit inside {@link oxyRoutingReadinessReport}, where it
 * blocked the deploy. It was added by #576 — "PREPARE Oxy-backed read-aloud" —
 * and the first deploy created after that commit failed on it, 17 seconds later.
 * Every deploy since has been blocked, so no unrelated fix could reach
 * production either.
 *
 * The profile is not missing by accident and Alia cannot create it. Oxy's
 * `docs/inference/speech-recovery-2026-09-13.md` reserves this exact id for
 * Alia and states that provisioning it needs "normal reviewer authority,
 * immutable price/score records and exact credential binding", that "no speech
 * catalogue provisioning is included in this candidate", and that speech must
 * not be called live before that lands. So this gate was refusing to deploy
 * until an upstream decision it does not control was taken.
 *
 * Blocking also bought nothing. `lib/synthesize-speech.ts` names this profile on
 * the request itself, so with the profile absent read-aloud fails at call time
 * whether or not this deploy happens — the gate could not keep speech working,
 * only keep everything else from shipping.
 *
 * MAKE IT BLOCKING AGAIN once Oxy provisions the profile: move the id back into
 * the list above and delete this. A gate for a capability that exists is worth
 * having; this one guarded a capability that had not been built yet.
 */
export function speechReadinessReport(routingProfileIds: readonly string[]) {
  return {
    provisioned: new Set(routingProfileIds).has(OXY_KAANA_SPEECH_ROUTING_PROFILE_ID),
    routingProfileId: OXY_KAANA_SPEECH_ROUTING_PROFILE_ID,
  };
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
  const speechReport = speechReadinessReport(visibleIds);
  // `speech` is deliberately absent from this conjunction — see its report.
  const report = { ready: agentsReport.ready && oxyReport.ready, agents: agentsReport, oxy: oxyReport, speech: speechReport };
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
