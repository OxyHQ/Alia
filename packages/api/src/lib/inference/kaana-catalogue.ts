/**
 * What Kaana serves, asked of Kaana.
 *
 * ## Why this exists rather than a table in this repository
 *
 * Alia used to answer "which models can we route to" from a hand-written tier
 * table. Measured against Kaana's live snapshot on 2026-08-23: 32 of its 65
 * entries resolved, and half the misses were SPELLING — `xai/` against
 * `x-ai/`, `mistral/` against `mistralai/`, `meta/llama-3.3-70b` against
 * `meta-llama/llama-3.3-70b-instruct` — on models Kaana was serving the whole
 * time. The same snapshot carried 353 deployments, including model lines the
 * table has no row for at all.
 *
 * A copy of someone else's catalogue drifts in one direction: it keeps offering
 * what was removed and never offers what was added. So this asks.
 *
 * ## Being unable to ask is not the same as an empty answer
 *
 * Kaana may not serve this route yet, may be unreachable, may be misconfigured
 * here. All three yield `null` — never an empty catalogue — because an empty
 * catalogue means "Kaana serves nothing", and a caller acting on that would
 * route everything away from Kaana on a transient failure. `null` says "I do
 * not know", and the caller keeps doing what it was doing.
 */

import { getKaanaClient } from './kaana.js';
import {
  KAANA_EDGE_KEY_ID_ENV,
  KAANA_EDGE_PRIVATE_KEY_ENV,
  readEdgePrivateKey,
  signEnvelope,
} from './kaana-transport.js';
import { KAANA_PRINCIPAL_ENV } from './kaana-boot-check.js';
import { resolveKaanaEndpoint } from './kaana-endpoint.js';

/** The route Kaana answers its catalogue on. */
const CATALOGUE_PATH = '/internal/v1/models';

/**
 * How long an answer is held.
 *
 * Kaana's publisher rewrites the snapshot every fifteen minutes, so anything
 * shorter re-asks a question whose answer has not changed. Five minutes bounds
 * how long a newly published model stays invisible here without making the
 * route hot.
 */
const CATALOGUE_TTL_MS = 5 * 60 * 1000;

/**
 * How long a FAILURE is held, which is much shorter and deliberately so.
 *
 * Caching "I could not ask" for five minutes would turn one bad response into
 * five minutes of routing everything away from Kaana. Thirty seconds is long
 * enough to stop a failing route being retried on every request and short
 * enough that recovery is not something anyone waits for.
 */
const FAILURE_TTL_MS = 30 * 1000;

export interface KaanaCatalogueEntry {
  /** The model line, which survives a revision bump: `anthropic/claude-sonnet-4`. */
  readonly model: string;
  /** The revision that line resolves to today. Reported, never sent back. */
  readonly modelReference: string;
  /** Providers that can serve it. Which one does is Kaana's decision. */
  readonly providers: readonly string[];
}

export interface KaanaCatalogue {
  readonly snapshotId: string;
  /**
   * Whether an unpinned name resolves AT ALL right now.
   *
   * False means Kaana's snapshot is past its staleness horizon and every entry
   * below would be refused. A consumer that read `models` without reading this
   * would route to names that all fail, one request at a time.
   */
  readonly servesUnpinned: boolean;
  readonly models: readonly KaanaCatalogueEntry[];
}

interface CacheEntry {
  readonly catalogue: KaanaCatalogue | null;
  readonly expiresAt: number;
}

let cached: CacheEntry | null = null;

/** Test seam: forget what was fetched so the next call asks again. */
export function resetKaanaCatalogue(): void {
  cached = null;
}

/**
 * The catalogue, fetched and signed.
 *
 * Signed with the same edge key and the same preimage as an inference envelope,
 * over the empty body a GET carries. Kaana verifies one scheme, so there is one
 * scheme here.
 */
export async function fetchKaanaCatalogue(
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<KaanaCatalogue | null> {
  const keyId = (env[KAANA_EDGE_KEY_ID_ENV] ?? '').trim();
  const pem = (env[KAANA_EDGE_PRIVATE_KEY_ENV] ?? '').trim();
  if (keyId === '' || pem === '') return null;

  const environment = (env[KAANA_PRINCIPAL_ENV.environment] ?? '').trim();
  if (environment !== 'production' && environment !== 'staging' && environment !== 'development') {
    return null;
  }
  const endpoint = resolveKaanaEndpoint(env, environment);
  if (endpoint.kind === 'refused') return null;

  let headers: Record<string, string>;
  try {
    headers = signEnvelope({ keyId, privateKey: readEdgePrivateKey(pem) }, '', Date.now());
  } catch {
    // A key this process cannot parse is a configuration fault, not an answer
    // about what Kaana serves.
    return null;
  }

  const response = await fetch(`${endpoint.endpoint}${CATALOGUE_PATH}`, {
    method: 'GET',
    headers: { Accept: 'application/json', ...headers },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) return null;

  const body: unknown = await response.json();
  return readCatalogue(body);
}

/**
 * The body, validated rather than trusted.
 *
 * A shape this does not recognise yields `null`, which the caller reads as "I
 * do not know" — the same as an unreachable Kaana. Coercing a partial body into
 * a catalogue would be worse: it would silently shrink the set of models the
 * product can route to, and look like a deliberate change.
 */
function readCatalogue(body: unknown): KaanaCatalogue | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.servesUnpinned !== 'boolean') return null;
  if (!Array.isArray(record.models)) return null;

  const models: KaanaCatalogueEntry[] = [];
  for (const entry of record.models) {
    if (typeof entry !== 'object' || entry === null) return null;
    const row = entry as Record<string, unknown>;
    if (typeof row.model !== 'string' || typeof row.modelReference !== 'string') return null;
    const providers = Array.isArray(row.providers)
      ? row.providers.filter((p): p is string => typeof p === 'string')
      : [];
    models.push({ model: row.model, modelReference: row.modelReference, providers });
  }

  // Under `configuration`, not at the top level: Kaana reports snapshot identity
  // through the same object on its health surface, so a catalogue read and a
  // health read can be compared without guessing whether they saw the same
  // file. Read from the top level this was silently always the empty string —
  // a wrong value rather than a missing one, which is the kind that gets
  // printed in a diagnostic and believed.
  const configuration = record.configuration;
  const snapshotId =
    typeof configuration === 'object' && configuration !== null &&
    typeof (configuration as Record<string, unknown>).snapshotId === 'string'
      ? ((configuration as Record<string, unknown>).snapshotId as string)
      : '';

  return { snapshotId, servesUnpinned: record.servesUnpinned, models };
}

/**
 * The catalogue, cached.
 *
 * One in-flight fetch is not deduplicated on purpose: two concurrent misses
 * cost two GETs against a route that returns a few hundred rows, and the
 * machinery to collapse them is a promise cache that has to be invalidated
 * correctly on failure. The cheaper thing is to let it happen.
 */
export async function getKaanaCatalogue(
  env: NodeJS.ProcessEnv = process.env,
): Promise<KaanaCatalogue | null> {
  const now = Date.now();
  if (cached !== null && cached.expiresAt > now) return cached.catalogue;

  let catalogue: KaanaCatalogue | null;
  try {
    catalogue = await fetchKaanaCatalogue(env, AbortSignal.timeout(5_000));
  } catch {
    catalogue = null;
  }
  cached = {
    catalogue,
    expiresAt: now + (catalogue === null ? FAILURE_TTL_MS : CATALOGUE_TTL_MS),
  };
  return catalogue;
}

/**
 * Alia's name for a model line, where Kaana spells it differently.
 *
 * Measured against the live catalogue on 2026-08-24: of the 27 lines Alia names
 * that Kaana did not serve, five were spelling and the rest were modalities
 * Kaana has no adapter for. All five are publisher spellings, and two of them
 * also carry a suffix Alia leaves off.
 *
 * ## Why Alia is not simply renamed to match
 *
 * `publisher` is not an internal identifier. `routes/catalogue.ts` publishes it,
 * and ADR 0003 makes `<publisher>/<model>` the canonical name a CUSTOMER pins.
 * Renaming `xai` to `x-ai` to match an upstream's spelling would break every
 * client that pinned the name Alia advertises — a breaking API change made to
 * settle a difference of opinion about hyphens.
 *
 * ## Why a map rather than matching on the model half
 *
 * Because `llama-3.3-70b` and `llama-3.3-70b-instruct` are one line here and
 * could be two elsewhere. Anything that matched on a suffix would eventually
 * route a request to a model nobody chose, which is the silent substitution
 * ADR 0003 exists to forbid. Five reviewed lines are cheaper than that.
 *
 * This is a translation at the seam and not a catalogue: it holds only names
 * that DIFFER, so it shrinks to nothing the day Kaana publishes aliases, and
 * an entry that stops being needed is dead rather than wrong.
 */
const KAANA_MODEL_LINE: Readonly<Record<string, string>> = {
  'alibaba/qwen3-32b': 'qwen/qwen3-32b',
  'meta/llama-3.3-70b': 'meta-llama/llama-3.3-70b-instruct',
  'mistral/mistral-small-3.1': 'mistralai/mistral-small-3.1-24b-instruct',
  'xai/grok-4.3': 'x-ai/grok-4.3',
  'xai/grok-4.6': 'x-ai/grok-4.6',
};

/** Exported for the test that reads it, and for an operator checking coverage. */
export const KAANA_MODEL_LINE_ALIASES = KAANA_MODEL_LINE;

/**
 * The name to send Kaana for a model Alia names, or `null` when Kaana does not
 * serve it.
 *
 * Returns the NAME rather than a boolean because the two can differ, and a
 * caller that asked "do you serve this?" and then sent its own spelling would
 * be asking one question and acting on another.
 *
 * `null` for anything this cannot confirm — an unreachable Kaana, a stale
 * snapshot, a client that is not configured. The caller's other path is the
 * in-process provider tree, which works; routing to Kaana on a guess does not.
 */
export async function kaanaReferenceFor(
  aliaModel: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (getKaanaClient(env) === null) return null;
  const catalogue = await getKaanaCatalogue(env);
  if (catalogue === null || !catalogue.servesUnpinned) return null;
  // `Object.hasOwn` rather than a truthy or nullish read: `aliaModel` reaches
  // here from a routing table whose entries a request can influence, and
  // `KAANA_MODEL_LINE['constructor']` is the Object CONSTRUCTOR — a value, so
  // `??` never fires and the name sent onward would be a function.
  const line = Object.hasOwn(KAANA_MODEL_LINE, aliaModel) ? KAANA_MODEL_LINE[aliaModel] : aliaModel;
  return catalogue.models.some((entry) => entry.model === line) ? line : null;
}
