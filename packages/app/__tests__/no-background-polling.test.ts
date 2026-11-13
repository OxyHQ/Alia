import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT } from '@/shared/testing/app-root';

/**
 * Nothing the app keeps mounted polls the API on a timer.
 *
 * On 2026-11-13 one person's open Gemies tab (the same hooks as here) sent 755 requests in 12 minutes, and as many CORS
 * preflights, until the API answered 429 to the conversations they were trying to open: the
 * connected agents every 6 s, credits every 10 s, the local runtimes and the agent list every 30 s,
 * notifications every minute, each from a hook mounted on every chat. Data that changes because
 * of a socket event is invalidated by that event (or will be: the realtime layer owns that seam);
 * the rest is read on mount and when the tab comes back.
 *
 * A timer is allowed only while a screen is SHOWING something live, and is listed here with why.
 */
const ALLOWED: Record<string, string> = {
  'src/features/billing/runtime/use-billing.ts':
    'the post-checkout poll: only after a checkout redirect, stops once the plan is active',
  'src/features/local-models/runtime/use-local-runtime.ts':
    'a probe of the person’s OWN machine (localhost), never the API',
};

const SKIP = new Set(['node_modules', '__tests__', 'dist', '.expo']);
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}
const FILES = ['src', 'app']
  .flatMap((dir) => sources(join(APP_ROOT, dir)))
  .map((path) => ({ path: relative(APP_ROOT, path), source: readFileSync(path, 'utf8') }));

/** A query interval that is not `false`, or a `setInterval` beside an API call. */
function polls(source: string): boolean {
  const interval = /refetchInterval\s*:(?!\s*false\b)/.test(source);
  const timer = /\bsetInterval\(/.test(source) && /\bapiClient\.|\bfetch\(/.test(source);
  return interval || timer;
}

describe('no background polling', () => {
  it('polls only where a live screen needs it', () => {
    const offenders = FILES.filter(({ path, source }) => !(path in ALLOWED) && polls(source)).map(
      ({ path }) => path,
    );
    expect(offenders).toEqual([]);
  });

  it('lists no exception that no longer polls', () => {
    const stale = Object.keys(ALLOWED).filter(
      (path) => !FILES.some((file) => file.path === path && polls(file.source)),
    );
    expect(stale).toEqual([]);
  });

  it('sees an interval (the control)', () => {
    expect(polls('useQuery({ refetchInterval: 10_000 })')).toBe(true);
    expect(polls('useQuery({ refetchInterval: false })')).toBe(false);
    expect(polls('setInterval(() => void apiClient.get("/x"), 6000)')).toBe(true);
  });
});
