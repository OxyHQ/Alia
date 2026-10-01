/**
 * Watch tasks: "tell me when Meta announces something new".
 *
 * A two-tier monitor (the shape of openmuse's `service.observe` /
 * `createMonitor`, MIT). Every scheduled tick first does a CHEAP observation
 * with no model — a Clarity search for a query, or a Clarity page read for a
 * URL — normalises it and hashes it. Only when that observation crosses the
 * watch's condition does the dispatcher queue a full Alia run, which reads the
 * change, decides whether it is worth telling the person, and says so in the
 * task's conversation. A tick costs no credits; only that model run does.
 *
 * - `change`: a URL's normalised text hash differs, or a query returned a
 *   result URL never seen before (a reshuffle of known results is not news).
 * - `contains`: the value appears where it did not at the last good tick
 *   (rising edge; the first tick counts).
 *
 * The first good tick of a `change` watch is the baseline and never fires.
 * Durable state lives in `automation_watch_states`; the configuration is the
 * task's `inputs.watch`. The model run's trigger id is `watch:<id>:<hash>`,
 * which makes the run — and so its one message and notification — idempotent
 * per observed content. Failures back off `min(60, 2^n)` minutes and pause
 * the task after {@link WATCH_PAUSE_AFTER_FAILURES} in a row, with one
 * notification for the whole streak (`automation-dispatcher.ts`).
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { readWebPage } from './tools/web-scraper.js';
import type { searchWeb, WebSearchResult } from './tools/web-search.js';

export const WATCH_INPUT_KEY = 'watch';
export const WATCH_PAUSE_AFTER_FAILURES = 5;
/** How much of the observed text a model run is shown. */
const EXCERPT_CHARS = 4_000;
const MAX_NEW_RESULTS = 8;

export const watchConfigSchema = z.object({
  url: z.string().url().max(2_048).optional()
    .describe('A public page to watch. Exactly one of url or query.'),
  query: z.string().trim().min(2).max(300).optional()
    .describe('A web search to watch for new results, e.g. "Meta announcement". Exactly one of url or query.'),
  condition: z.enum(['change', 'contains']).default('change')
    .describe('change: something new appears; contains: value appears'),
  value: z.string().trim().min(1).max(200).optional()
    .describe('Required for contains: the text to look for (case-insensitive)'),
}).strict().superRefine((config, context) => {
  if ((config.url === undefined) === (config.query === undefined)) {
    context.addIssue({ code: 'custom', path: ['url'], message: 'A watch needs exactly one of url or query' });
  }
  if (config.condition === 'contains' && config.value === undefined) {
    context.addIssue({ code: 'custom', path: ['value'], message: 'A contains watch needs a value' });
  }
});

export type WatchConfig = z.infer<typeof watchConfigSchema>;

/** The task's watch, or `null` for an ordinary task (or a malformed watch). */
export function watchConfigOf(inputs: Record<string, unknown>): WatchConfig | null {
  const raw = inputs[WATCH_INPUT_KEY];
  if (raw === undefined) return null;
  const parsed = watchConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export interface WatchObservation {
  hash: string;
  /** Query watches: result URLs, sorted. Empty for a URL watch. */
  items: string[];
  /** Normalised observed text, for `contains` and the model's excerpt. */
  text: string;
  /** Query watches: the results themselves. */
  results: WebSearchResult[];
}

export class WatchSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchSourceError';
  }
}

export function normalizeWatchText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface WatchSources {
  searchWeb: typeof searchWeb;
  readWebPage: typeof readWebPage;
}

/**
 * Loaded on first use: this module is reached from task creation, and the
 * chat path that creates tasks mocks the web tools wholesale in its tests.
 */
const DEFAULT_SOURCES: WatchSources = {
  searchWeb: async (query) => (await import('./tools/web-search.js')).searchWeb(query),
  readWebPage: async (url) => (await import('./tools/web-scraper.js')).readWebPage(url),
};

/** The cheap tier: one Clarity call, no model. Throws {@link WatchSourceError}. */
export async function observeWatchSource(
  config: WatchConfig,
  sources: WatchSources = DEFAULT_SOURCES,
): Promise<WatchObservation> {
  if (config.query !== undefined) {
    const response = await sources.searchWeb(config.query);
    if (response.error) throw new WatchSourceError(`search failed: ${response.error}`);
    const items = [...new Set(response.results.map((result) => result.url))].sort();
    const text = normalizeWatchText(response.results.map((result) => `${result.title} ${result.snippet}`).join('\n'));
    // Hashed on the URLs alone: snippets churn without anything being new.
    return { hash: sha256(items.join('\n')), items, text, results: response.results };
  }
  const page = await sources.readWebPage(config.url ?? '');
  if ('error' in page) throw new WatchSourceError(`read failed: ${page.error}`);
  const text = normalizeWatchText(`${page.title}\n${page.content}`);
  return { hash: sha256(text), items: [], text, results: [] };
}

export interface WatchPreviousState {
  lastHash: string | null;
  lastItems: readonly string[];
  matched: boolean;
}

export interface WatchDecision {
  /** Queue the model run. */
  fire: boolean;
  /** The observation differs from the last good one (not on the baseline). */
  changed: boolean;
  /** `contains`: the value is present now. */
  matched: boolean;
  /** Query watches: result URLs not seen at the last good tick. */
  newItems: string[];
}

export function decideWatch(
  config: WatchConfig,
  previous: WatchPreviousState | null,
  observation: WatchObservation,
): WatchDecision {
  const baseline = !previous?.lastHash;
  const seen = new Set(previous?.lastItems ?? []);
  const newItems = baseline || config.query === undefined
    ? []
    : observation.items.filter((item) => !seen.has(item));
  const changed = !baseline && (config.query !== undefined
    ? newItems.length > 0
    : observation.hash !== previous?.lastHash);
  const matched = config.condition === 'contains' && config.value !== undefined
    && observation.text.toLowerCase().includes(config.value.toLowerCase());
  const fire = config.condition === 'contains'
    ? matched && !(previous?.matched ?? false)
    : changed;
  return { fire, changed, matched, newItems };
}

/** The idempotency key of the model run (and its notification) for one observation. */
export function watchTriggerId(automationId: string, hash: string): string {
  return `watch:${automationId}:${hash}`;
}

/** What the model run is shown about the change that woke it. */
export function watchTriggerContext(
  config: WatchConfig,
  observation: WatchObservation,
  decision: WatchDecision,
): Record<string, unknown> {
  const fresh = new Set(decision.newItems);
  return {
    source: config.query !== undefined ? { query: config.query } : { url: config.url },
    condition: config.condition,
    ...(config.value !== undefined ? { value: config.value } : {}),
    ...(config.query !== undefined
      ? {
          newResults: observation.results
            .filter((result) => decision.newItems.length === 0 || fresh.has(result.url))
            .slice(0, MAX_NEW_RESULTS)
            .map((result) => ({ title: result.title, url: result.url, snippet: result.snippet })),
        }
      : { excerpt: observation.text.slice(0, EXCERPT_CHARS) }),
  };
}
