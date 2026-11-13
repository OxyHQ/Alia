import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT } from '@/shared/testing/app-root';

/**
 * Every screen draws at once: what this session or the account's cache already holds, else the
 * screen's skeleton, and never a blank or a wait on the network (docs/instant-loading.md).
 *
 * That holds only while a screen's data is a QUERY: React Query serves the cached answer first and
 * refreshes it behind (stale-while-revalidate), and the persisted roots survive a restart. Three
 * ways around it, each of which a screen used:
 *
 *  1. Fetching from a `useEffect` into `useState`: nothing is cached, so every visit starts from
 *     empty (Connectors, Security, Writing style; the composer's connector list on every chat).
 *  2. `gcTime: 0` on a query a screen draws: the answer is dropped the moment the screen unmounts,
 *     so the next visit waits again (billing, credits, entitlements).
 *  3. `return null` while loading: a blank where the skeleton should be.
 *
 * Exceptions are listed with the reason; a new one has to say why it is not screen data.
 */

const ROOTS = ['app', 'src'].map((dir) => join(APP_ROOT, dir)).filter(existsSync);
const SKIP = new Set(['node_modules', '__tests__', 'dist', '.expo']);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|stories)\./.test(entry.name) ? [path] : [];
  });
}

const FILES = ROOTS.flatMap(sources).map((path) => ({
  path: relative(APP_ROOT, path),
  source: readFileSync(path, 'utf8'),
}));

/** The body of each `useEffect(() => { … })`, by brace matching from its arrow. */
function effectBodies(source: string): string[] {
  const bodies: string[] = [];
  const opener = /useEffect\(\s*(?:async\s*)?\(\)\s*=>\s*\{/g;
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
    }
    bodies.push(source.slice(match.index + match[0].length, i));
  }
  return bodies;
}

const FETCHES = /\bapiClient\.(get|post)\(|(^|[^.\w])fetch\(|\bexpoFetch\(/m;

/** Effects that fetch, but not a screen's data. */
const EFFECT_FETCH_EXCEPTIONS: Record<string, string> = {
  'src/features/notifications/runtime/use-notification-setup.ts':
    'push registration (the VAPID key, then subscribe): a side effect of signing in, drawn nowhere',
};

/** Queries that drop their answer on unmount on purpose, and why that is not a screen waiting. */
const GC_ZERO_EXCEPTIONS: Record<string, string> = {
  'src/features/billing/runtime/use-billing.ts':
    'the post-checkout poll: a wait for the webhook, drawn by the checkout flow, never a screen',
};

/** `return null` while loading, where the skeleton is drawn by something else. */
const NULL_WHILE_LOADING_EXCEPTIONS: Record<string, string> = {};

describe('screens draw from the cache', () => {
  it('fetch screen data as queries, never from an effect', () => {
    const offenders = FILES.filter(
      ({ path, source }) =>
        !(path in EFFECT_FETCH_EXCEPTIONS) &&
        effectBodies(source).some((body) => FETCHES.test(body)),
    ).map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('keep a screen’s answer for the next visit (no gcTime: 0)', () => {
    const offenders = FILES.filter(
      ({ path, source }) => !(path in GC_ZERO_EXCEPTIONS) && /\bgcTime:\s*0\b/.test(source),
    ).map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('draw a skeleton while loading, never a blank', () => {
    const offenders = FILES.filter(
      ({ path, source }) =>
        !(path in NULL_WHILE_LOADING_EXCEPTIONS) &&
        /if\s*\(\s*!?(?:\w+\.)?(?:isLoading|isPending|loading)\s*\)\s*\{?\s*return null/.test(
          source,
        ),
    ).map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('list no exception that no longer applies', () => {
    const stale = [
      ...Object.keys(EFFECT_FETCH_EXCEPTIONS),
      ...Object.keys(GC_ZERO_EXCEPTIONS),
      ...Object.keys(NULL_WHILE_LOADING_EXCEPTIONS),
    ].filter((path) => !FILES.some((file) => file.path === path));
    expect(stale).toEqual([]);
  });

  it('finds an effect that fetches (the control)', () => {
    const source = 'useEffect(() => { apiClient.get("/x").then(setRows); }, []);';
    expect(effectBodies(source).some((body) => FETCHES.test(body))).toBe(true);
    expect(
      effectBodies('useEffect(() => { setOpen(true); }, []);').some((b) => FETCHES.test(b)),
    ).toBe(false);
  });
});
