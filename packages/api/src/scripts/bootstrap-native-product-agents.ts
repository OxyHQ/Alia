import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { agents } from '../db/schema/agents.js';
import { closePostgres, connectPostgres, type ApiDatabase, type Executor } from '../db/index.js';
import {
  NATIVE_PRODUCT_AGENT_IDENTITY,
  loadNativeProductAgentSpecs,
  nativeProductAgentHandoffManifest,
  type LoadedNativeProductAgentSpec,
} from '../config/native-product-agents.js';
import {
  oxyAuthorityReader,
  verifyNativeProductAgentAuthority,
  type OxyNativeProductAuthorityReader,
} from '../lib/native-product-agent-authority.js';
import {
  buildNativeProductAgentPlan,
  canonicalNativeProductAgentPlan,
  nativeProductAgentPlanSha256,
  requireNativeProductAgentApproval,
  type NativeProductAgentBootstrapDirection,
  type NativeProductAgentBootstrapPlan,
  type NativeProductAgentStoredState,
} from './native-product-agent-bootstrap-plan.js';

const ADVISORY_LOCK = 'alia:native-product-agent-bootstrap:v1';
const CANONICAL_OXY_ORIGIN = 'https://api.oxy.so';

/** Prevent an operator bearer from being sent to a lookalike/exfiltration URL. */
export function assertOxyBootstrapOrigin(
  raw: string | undefined,
  options: { mutate: boolean; allowLoopback: boolean },
): string {
  if (raw === undefined || raw === '') throw new Error('OXY_API_URL is required');
  if (raw === CANONICAL_OXY_ORIGIN) return raw;
  if (options.mutate) {
    throw new Error(`APPLY/ROLLBACK requires OXY_API_URL=${CANONICAL_OXY_ORIGIN}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('OXY_API_URL must be an exact origin');
  }
  const loopback = parsed.hostname === '127.0.0.1'
    || parsed.hostname === 'localhost'
    || parsed.hostname === '[::1]';
  if (
    !options.allowLoopback
    || parsed.protocol !== 'http:'
    || !loopback
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
    || raw !== parsed.origin
  ) {
    throw new Error(`OXY_API_URL must be ${CANONICAL_OXY_ORIGIN} or an explicitly allowed loopback dry-run origin`);
  }
  return raw;
}

function state(row: typeof agents.$inferSelect): NativeProductAgentStoredState {
  return {
    id: row.id,
    oxyAccountId: row.oxyAccountId,
    ownerOxyAccountId: row.ownerOxyAccountId,
    applicationId: row.applicationId,
    tagline: row.tagline,
    description: row.description,
    authorOxyUserId: row.authorOxyUserId,
    category: row.category,
    tags: row.tags,
    capabilityGrants: row.capabilityGrants,
    isPublished: row.isPublished,
    status: row.status,
    access: row.access,
    systemPrompt: row.systemPrompt,
    routingProfileId: row.routingProfileId,
    archetype: row.archetype,
    archetypeConfig: row.archetypeConfig,
  };
}

async function readCandidates(
  tx: Executor,
  specs: readonly LoadedNativeProductAgentSpec[],
): Promise<NativeProductAgentStoredState[]> {
  const ids = specs.map((spec) => spec.agentId);
  const bots = specs.map((spec) => spec.botAccountId);
  const apps = specs.map((spec) => spec.bindingApplicationId);
  const rows = await tx
    .select()
    .from(agents)
    .where(or(inArray(agents.id, ids), inArray(agents.oxyAccountId, bots), inArray(agents.applicationId, apps)))
    .for('update');
  return rows.map(state);
}

async function writePlan(
  tx: Executor,
  direction: NativeProductAgentBootstrapDirection,
  specs: readonly LoadedNativeProductAgentSpec[],
): Promise<void> {
  for (const spec of specs) {
    if (direction === 'rollback') {
      await tx
        .update(agents)
        .set({ isPublished: false, access: 'private', status: 'offline', applicationId: null })
        .where(and(eq(agents.id, spec.agentId), eq(agents.oxyAccountId, spec.botAccountId)));
      continue;
    }

    const desired = spec.row;
    await tx
      .insert(agents)
      .values({
        id: desired.id,
        oxyAccountId: desired.oxyAccountId,
        ownerOxyAccountId: desired.ownerOxyAccountId,
        applicationId: desired.applicationId,
        tagline: desired.tagline,
        description: desired.description,
        authorOxyUserId: desired.authorOxyUserId,
        category: desired.category,
        tags: [...desired.tags],
        capabilityGrants: [...desired.capabilityGrants],
        isPublished: desired.isPublished,
        status: desired.status,
        access: desired.access,
        systemPrompt: desired.systemPrompt,
        routingProfileId: desired.routingProfileId,
        archetype: desired.archetype,
        archetypeConfig: desired.archetypeConfig,
      })
      .onConflictDoUpdate({
        target: agents.id,
        set: {
          ownerOxyAccountId: desired.ownerOxyAccountId,
          applicationId: desired.applicationId,
          tagline: desired.tagline,
          description: desired.description,
          authorOxyUserId: desired.authorOxyUserId,
          category: desired.category,
          tags: [...desired.tags],
          capabilityGrants: [...desired.capabilityGrants],
          isPublished: desired.isPublished,
          status: desired.status,
          access: desired.access,
          systemPrompt: desired.systemPrompt,
          routingProfileId: desired.routingProfileId,
          archetype: desired.archetype,
          archetypeConfig: desired.archetypeConfig,
          updatedAt: new Date(),
        },
      });
  }
}

export async function runNativeProductAgentBootstrap(input: {
  db: ApiDatabase;
  authority: OxyNativeProductAuthorityReader;
  direction: NativeProductAgentBootstrapDirection;
  mutate: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{ plan: NativeProductAgentBootstrapPlan; planSha256: string; approval?: { actor: string; reason: string } }> {
  const specs = loadNativeProductAgentSpecs();
  return input.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ADVISORY_LOCK}, 0))`);
    const authority = await verifyNativeProductAgentAuthority(
      input.authority,
      NATIVE_PRODUCT_AGENT_IDENTITY.oxyOrganizationId,
      specs,
    );
    const observed = await readCandidates(tx, specs);
    const plan = buildNativeProductAgentPlan({
      direction: input.direction,
      specs,
      authority,
      observed,
      desiredManifest: nativeProductAgentHandoffManifest(),
    });
    const planSha256 = nativeProductAgentPlanSha256(plan);
    if (!input.mutate) return { plan, planSha256 };

    const approval = requireNativeProductAgentApproval(planSha256, input.env ?? process.env);
    await writePlan(tx, input.direction, specs);
    const after = await readCandidates(tx, specs);
    const afterById = new Map(after.map((row) => [row.id, row]));
    const actualAfter = specs.map((spec) => afterById.get(spec.agentId) ?? null);
    if (JSON.stringify(actualAfter) !== JSON.stringify(plan.after)) {
      throw new Error('post-write state does not match the approved plan; transaction rolled back');
    }
    return { plan, planSha256, approval };
  });
}

function directionFromEnvironment(env: NodeJS.ProcessEnv): { direction: NativeProductAgentBootstrapDirection; mutate: boolean } {
  const apply = env.APPLY === '1';
  const rollback = env.ROLLBACK === '1';
  if (apply && rollback) throw new Error('APPLY=1 and ROLLBACK=1 are mutually exclusive');
  if (rollback) return { direction: 'rollback', mutate: true };
  return { direction: 'apply', mutate: apply };
}

function accessTokenFromFile(path: string | undefined): string {
  if (!path) throw new Error('OXY_BOOTSTRAP_ACCESS_TOKEN_FILE is required; authority verification fails closed');
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error('OXY_BOOTSTRAP_ACCESS_TOKEN_FILE must not be readable by group or others');
  }
  const token = readFileSync(path, 'utf8').trim();
  if (token === '') throw new Error('OXY_BOOTSTRAP_ACCESS_TOKEN_FILE is empty');
  return token;
}

async function main(): Promise<void> {
  const db = connectPostgres(process.env.DATABASE_URL);
  if (!db) throw new Error('DATABASE_URL is required');
  const { direction, mutate } = directionFromEnvironment(process.env);
  const baseURL = assertOxyBootstrapOrigin(process.env.OXY_API_URL, {
    mutate,
    allowLoopback: process.env.ALLOW_LOOPBACK_OXY_BOOTSTRAP === '1',
  });
  const token = accessTokenFromFile(process.env.OXY_BOOTSTRAP_ACCESS_TOKEN_FILE);
  const result = await runNativeProductAgentBootstrap({
    db,
    authority: oxyAuthorityReader(baseURL, token),
    direction,
    mutate,
  });
  process.stdout.write(`${JSON.stringify({
    mode: mutate ? direction : 'dry-run',
    planSha256: result.planSha256,
    plan: JSON.parse(canonicalNativeProductAgentPlan(result.plan)),
    ...(result.approval ? { approval: result.approval } : {}),
  }, null, 2)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(closePostgres);
}
