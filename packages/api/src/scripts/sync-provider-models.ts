#!/usr/bin/env node
/**
 * Compare the routing table against what each provider actually serves today,
 * and report the difference. It changes nothing.
 *
 * ```
 * node packages/api/dist/scripts/sync-provider-models.js --target-database=alia
 * ```
 *
 * ## Why a script and not a judgement call
 *
 * `generate-model-mappings.ts` names 56 concrete provider model ids. A model id
 * that an operator has retired still typechecks, still seeds, and still passes
 * every gate in this repo — it fails at the moment a user's request reaches the
 * provider, as a 404 from an upstream the sanitiser is careful not to name. So
 * the routing table drifts out of date silently, and the only way to know is to
 * ask each provider what it serves.
 *
 * Asking requires the credential, which is why this reads `provider_keys` — the
 * same rows `key-manager.ts` hands to the provider at request time. A provider
 * with no key is reported as unchecked rather than skipped quietly, because
 * "nothing to report" and "could not look" are the same output otherwise, and
 * that is exactly the confusion this exists to remove.
 *
 * ## It never prints a credential
 *
 * Keys are read, used as a bearer token, and never logged — not at debug, not
 * on error. An upstream error body is truncated and passed through
 * `readProviderErrorBody`, which redacts the credential it was sent with.
 *
 * ## Providers it cannot check
 *
 * Some operators publish no OpenAI-shaped catalogue endpoint. They are listed
 * explicitly in `NO_CATALOGUE` with the reason, and reported as such. Guessing a
 * URL for them would produce a confident wrong answer, which is worse than the
 * gap.
 */

import { readTargetDatabase } from '@oxyhq/db/migrate';
import { connectPostgres } from '../db/index.js';
import { assertTargetDatabase } from '../db/assertTargetDatabase.js';
import { getBestKeyForModel } from '../internal/providers/lib/key-manager.js';
import { GENERATED_TIER_MAPPINGS } from '../internal/providers/lib/generate-model-mappings.js';
import { readProviderErrorBody } from '../internal/providers/lib/provider-error-body.js';
import { catalogueUrlFor, NO_CATALOGUE } from './provider-catalogues.js';
import { log } from '../lib/logger.js';

/** Anthropic authenticates its catalogue differently from the OpenAI shape. */
function headersFor(provider: string, key: string): Record<string, string> {
  if (provider === 'anthropic') {
    return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  }
  return { Authorization: `Bearer ${key}` };
}

/** Both shapes this script accepts put the ids in `data[].id`. */
function idsFrom(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry === 'object' && entry !== null) {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string') ids.push(id);
    }
  }
  return ids;
}

type Report = {
  provider: string;
  /** `null` when the catalogue could not be read; the reason is in `note`. */
  live: readonly string[] | null;
  routed: readonly string[];
  note?: string;
};

async function readCatalogue(provider: string, key: string): Promise<{ ids: string[] | null; note?: string }> {
  const url = catalogueUrlFor(provider);
  if (url === null) {
    const reason = Object.hasOwn(NO_CATALOGUE, provider) ? NO_CATALOGUE[provider] : undefined;
    return { ids: null, note: reason ?? 'No catalogue path recorded for this provider.' };
  }

  let res: Response;
  try {
    res = await fetch(url, { headers: headersFor(provider, key) });
  } catch (error) {
    return { ids: null, note: `request failed: ${error instanceof Error ? error.message : 'unknown'}` };
  }

  if (!res.ok) {
    return { ids: null, note: `HTTP ${res.status}: ${await readProviderErrorBody(res, key)}` };
  }

  const ids = idsFrom(await res.json().catch(() => null));
  if (ids === null) {
    return { ids: null, note: 'catalogue did not answer the `data[].id` shape this script reads' };
  }
  return { ids };
}

async function main(): Promise<void> {
  const expectedDatabase = readTargetDatabase(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!connectPostgres(databaseUrl)) throw new Error('DATABASE_URL is required');
  await assertTargetDatabase(expectedDatabase);

  // What the routing table asks each provider for.
  const routed = new Map<string, Set<string>>();
  for (const mappings of Object.values(GENERATED_TIER_MAPPINGS)) {
    for (const mapping of mappings) {
      const set = routed.get(mapping.provider) ?? new Set<string>();
      set.add(mapping.modelId);
      routed.set(mapping.provider, set);
    }
  }

  const reports: Report[] = [];
  for (const [provider, models] of [...routed].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...models].sort();

    // Asked through the same selector the request path uses, rather than by
    // reading the column: the credential stays inside the provider tree, and a
    // provider this returns nothing for is one a real request could not reach
    // either — an open circuit and a missing key are both worth reporting.
    const keyConfig = await getBestKeyForModel(provider, sorted[0] ?? '');
    if (keyConfig === null) {
      reports.push({
        provider,
        live: null,
        routed: sorted,
        note: 'no key the request path would use — absent, inactive, exhausted or circuit-open',
      });
      continue;
    }

    const { ids, note } = await readCatalogue(provider, keyConfig.key);
    reports.push({ provider, live: ids, routed: sorted, note });
  }

  let stale = 0;
  let unchecked = 0;
  for (const report of reports) {
    if (report.live === null) {
      unchecked += 1;
      log.seed.warn({ provider: report.provider, routed: report.routed.length, note: report.note }, 'UNCHECKED');
      continue;
    }
    const live = new Set(report.live);
    const missing = report.routed.filter((id) => !live.has(id));
    stale += missing.length;
    log.seed.info(
      { provider: report.provider, routed: report.routed.length, live: live.size, missing },
      missing.length === 0 ? 'OK — every routed model is still served' : 'STALE — routed models the provider no longer lists',
    );
  }

  log.seed.info({ providers: reports.length, unchecked, staleModels: stale }, 'sync-provider-models finished');

  // A report is not a fix, and an exit code that hid the difference would let
  // this run green in a pipeline while the table stayed wrong.
  if (stale > 0) process.exitCode = 1;
}

await main();
