#!/usr/bin/env node
/**
 * Put a provider credential into `provider_keys`, or rotate the one that is
 * there — the sanctioned path, because there is not otherwise one.
 *
 * ```
 * node packages/api/dist/scripts/provider-key.js \
 *   --target-database=alia --provider=openai --name='openai primary' \
 *   --from-ssm=/oxy/alia/PROVIDER_KEY_OPENAI_PRIMARY
 * ```
 *
 * ## Why this exists at all
 *
 * `provider_keys` has NO admin API, and that is a deliberate security property
 * rather than a gap — `routes/__tests__/inference-boundary.test.ts` lists
 * `createProviderKey` / `updateProviderKey` / `deleteProviderKey` as writers
 * with zero runtime callers and fails if any route file calls one. **Do not add
 * one.** What was missing is not an API but a MECHANISM, and until now the only
 * route was hand-written SQL against production, which is how a credential ends
 * up in a shell history.
 *
 * ## It takes a parameter NAME, never a value
 *
 * The credential is read from SSM inside the task. Nothing sensitive appears in
 * `argv`, so nothing reaches a shell history, the ECS task description, or the
 * CloudWatch log of the command that started it. The one thing this file logs
 * about a credential is its `key_prefix`, which exists for that.
 *
 * **`ssm:GetParameter` is a prerequisite the task role does not have today.**
 * `oxy-ecs-task` carries only the two S3 policies; `simulate-principal-policy`
 * for `ssm:GetParameter` returns `implicitDeny` (the EXECUTION role returns
 * `allowed`, which is how `secrets` are injected at launch and is the control
 * proving the simulation works). Granting it on `/oxy/alia/PROVIDER_KEY_*` is
 * an `oxy-infra` change and must land first.
 *
 * The alternative — declaring the credential as a task-definition `secrets`
 * entry — is architecturally closed: `run-task --overrides` cannot add secrets,
 * and it would put an upstream provider credential in EVERY task's environment,
 * which is what #139 ws15 removed and what `lib/inference/direct-provider-guard.ts`
 * refuses to boot on.
 *
 * ## Why it is NOT wired into the deploy
 *
 * `scripts/seed.ts` runs on every release and that is right for reference data.
 * A credential is not release-scoped, and the failure mode is the expensive one:
 * an operator who rotates a key directly in the database would have it silently
 * REVERTED by the next unrelated deploy reading a stale SSM parameter, surfacing
 * weeks later as intermittent auth failures. This is issued deliberately, by a
 * person, as a one-shot `run-task` on the service's current revision.
 *
 * ## The credential is written in PLAINTEXT, deliberately
 *
 * `db/schema/providers.ts` stores `key` as `text()`, not the `encryptedText()`
 * custom type five other columns in this schema use. That is an exception with
 * a reason (see the table comment), and it is load-bearing HERE: encrypting on
 * the way in would store ciphertext that `key-manager.ts` hands to the provider
 * verbatim as the API key. Every upstream call would fail authentication while
 * the row looked perfectly stored.
 *
 * ## Three outcomes, dispatched on the hash
 *
 * `onConflictDoNothing` — right for the seeders — would be wrong here in the
 * direction with the longest fuse: a rotation would silently do nothing, the
 * command would exit 0, and a credential the operator believes replaced would
 * still be serving traffic.
 */

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { readTargetDatabase } from '@oxyhq/db/migrate';

import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import { assertTargetDatabase } from '../db/assertTargetDatabase.js';
import {
  createProviderKey,
  hashProviderKey,
  listSafeProviderKeys,
  providerKeyHashExists,
  providerKeyPrefix,
  rotateProviderKey,
} from '../db/providers/providerKeyRepository.js';
import { PROVIDER_KEY_ENVIRONMENTS, PROVIDER_KEY_TIERS } from '../domain/provider-key.js';
import { PROVIDER_NAMES } from '../internal/providers/lib/provider-names.js';
import { disclosedCredentialMatching } from '../lib/security/known-disclosures.js';
import type { ConfigAuditActor } from '../lib/security/config-audit.js';
import { log } from '../lib/logger.js';

const logger = log.keys;

/**
 * Who did it, for the audit record both writers emit.
 *
 * `service` rather than `seed`: a person chose this value and chose this moment,
 * which is the distinction `config-audit.ts` draws. There is no Oxy user id to
 * attribute it to — the caller is whoever holds `ecs:RunTask`.
 */
const ACTOR: ConfigAuditActor = { kind: 'service', id: 'scripts/provider-key' };

function flag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length).trim() || undefined;
}

function requireFlag(argv: readonly string[], name: string): string {
  const value = flag(argv, name);
  if (value === undefined) throw new Error(`--${name}=<value> is required`);
  return value;
}

function requireOneOf(name: string, value: string, allowed: readonly string[]): string {
  if (!allowed.includes(value)) {
    // The closed set, spelled out. A value rejected here would otherwise be
    // rejected by a CHECK constraint, after the credential had been read.
    throw new Error(`--${name}=${value} is not one of: ${allowed.join(', ')}`);
  }
  return value;
}

async function readCredentialFromSsm(parameterName: string, region: string): Promise<string> {
  const ssm = new SSMClient({ region });
  const result = await ssm.send(
    new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
  );
  const value = result.Parameter?.Value;
  if (value === undefined || value.length === 0) {
    throw new Error(`SSM parameter ${parameterName} is empty or has no value`);
  }
  return value;
}

/** The target guard `db/migrate.ts` requires, for the same reason and as the first statement. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Every argument is parsed and validated BEFORE the credential is read, so a
  // typo fails without a secret ever having been in this process's memory.
  const expectedDatabase = readTargetDatabase(argv);
  const provider = requireOneOf('provider', requireFlag(argv, 'provider'), PROVIDER_NAMES);
  const name = requireFlag(argv, 'name');
  const parameterName = requireFlag(argv, 'from-ssm');
  const environment = requireOneOf(
    'environment',
    flag(argv, 'environment') ?? 'production',
    PROVIDER_KEY_ENVIRONMENTS,
  );
  const tier = requireOneOf('tier', flag(argv, 'tier') ?? 'paid', PROVIDER_KEY_TIERS);
  const region = process.env.AWS_REGION;
  if (!region) throw new Error('AWS_REGION is required to read the SSM parameter');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!connectPostgres(databaseUrl)) throw new Error('DATABASE_URL is required');
  await assertTargetDatabase(expectedDatabase);

  const key = await readCredentialFromSsm(parameterName, region);

  const keyHash = hashProviderKey(key);
  const disclosed = disclosedCredentialMatching(keyHash);
  if (disclosed !== null) {
    // Names the LEDGER ENTRY, never the value. The entry itself carries no
    // credential — it is a pattern and a digest — so this is safe to print and
    // is the one thing that tells an operator which paste went wrong.
    throw new Error(
      `refusing to write a credential published in this repository's git history (${disclosed}). ` +
        `Mint a replacement at the provider and put THAT in ${parameterName}.`,
    );
  }

  const keyPrefix = providerKeyPrefix(key);

  if (await providerKeyHashExists(getDb(), keyHash)) {
    // Idempotent re-run. Not an error: the whole point of dispatching on the
    // hash is that issuing this twice is safe.
    logger.info({ provider, name, keyPrefix }, 'Provider key already present, unchanged');
    return;
  }

  // `listSafeProviderKeys` projects `key` and `key_hash` away, so nothing here
  // holds a second credential. Matching on NAME within a provider is what makes
  // this a rotation rather than a second row: `key_hash` carries a unique index,
  // so an insert of a rotated credential beside the old one would leave two live
  // keys where the operator meant one.
  const existing = (await listSafeProviderKeys(getDb(), { provider })).filter(
    (row) => row.name === name,
  );
  if (existing.length > 1) {
    throw new Error(
      `refusing to rotate: ${existing.length} keys named ${JSON.stringify(name)} exist for ${provider}. Resolve by id.`,
    );
  }

  if (existing.length === 1) {
    const rotated = await rotateProviderKey(getDb(), existing[0].id, key, new Date(), ACTOR);
    if (rotated === null) throw new Error(`rotation matched no row for id ${existing[0].id}`);
    logger.warn(
      { provider, name, id: rotated.id, keyPrefix, previousKeyPrefix: existing[0].keyPrefix },
      'Provider key ROTATED — the previous credential is no longer in service and should be revoked upstream',
    );
    return;
  }

  const created = await createProviderKey(
    getDb(),
    {
      name,
      provider,
      keyHash,
      keyPrefix,
      key,
      environment,
      isPaid: tier !== 'free',
      tier,
      // Lowest priority wins, and a new key joins at the back rather than
      // displacing whatever is serving. Raising it is a separate, deliberate act.
      priority: 100,
      rateLimit: {},
      creditLimitUsd: null,
      rateLimitResetMs: null,
    },
    ACTOR,
  );
  logger.info({ provider, name, id: created.id, keyPrefix, environment, tier }, 'Provider key created');
}

main().then(
  async () => {
    await closePostgres();
    process.exit(0);
  },
  async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    const cause: unknown = error instanceof Error ? error.cause : undefined;
    if (cause !== undefined) {
      const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : undefined;
      console.error(`cause: ${cause instanceof Error ? cause.message : String(cause)}`);
      if (code !== undefined) console.error(`sqlstate: ${code}`);
    }
    await closePostgres().catch(() => {});
    process.exit(1);
  },
);
