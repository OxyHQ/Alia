import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No screen waits behind a spinner or a "Loading..." (docs/instant-loading.md).
 *
 * Nobody opens a screen of a good app to find the word "Loading". What a screen is waiting for has
 * a shape (rows, a header, a thread), and Bloom's skeleton draws it (`src/shared/ui/skeletons`, the
 * SDK's `ThreadSkeleton`): the screen holds its place and nothing moves when the data arrives. A
 * spinner is for an ACTION in progress (a step that is running, a message being answered), never
 * for a screen or a list. The SDK's own screens are held to the same in OxyHQ/Gemies.
 *
 * Source gates, like the other `__tests__/*.test.ts`: they read the files, so a new spinner fails
 * here, before review.
 *
 *  1. Only the files in {@link ACTION_SPINNERS} may import Bloom's `Loading`, each for an action in
 *     progress. A new one is a claim that the wait is an action, and is said here.
 *  2. Nothing uses React Native's `ActivityIndicator`.
 *  3. Nothing draws a `Loading` with a `text` (a word about waiting), and no component reads a
 *     `*.loading` copy key: those keys do not exist.
 *  4. No locale string says "Loading" or "Cargando" about a screen: the strings are gone.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = [join(ROOT, 'app'), join(ROOT, 'src')];

/** Files that may import Bloom's `Loading`, and the action each one shows it for. */
const ACTION_SPINNERS = new Map<string, string>([
  [
    'app/(app)/authorize/index.tsx',
    'linking an account: an action the person started, with its own title and description',
  ],
  ['src/shell/sidebar-menus.tsx', 'the chat that is being answered right now (StreamingIndicator)'],
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '__tests__' || name === 'tests') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    // `__*.tsx` are local galleries, never committed.
    if (name.startsWith('__') && !name.endsWith('.test.tsx')) return [];
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const FILES = DIRS.flatMap(sourceFiles).map((file) => ({
  path: relative(ROOT, file),
  source: readFileSync(file, 'utf8'),
}));

describe('screens that wait', () => {
  it('reads every screen and component', () => {
    // Without this the assertions below pass over nothing.
    expect(FILES.length).toBeGreaterThan(100);
  });

  it('imports Bloom’s Loading only for an action in progress, and says which', () => {
    const importing = FILES.filter(({ source }) => source.includes('@oxy.so/bloom/loading')).map(
      ({ path }) => path,
    );
    expect(importing.sort()).toEqual([...ACTION_SPINNERS.keys()].sort());
  });

  it('has no ActivityIndicator', () => {
    const found = FILES.filter(({ source }) => /\bActivityIndicator\b/.test(source)).map(
      ({ path }) => path,
    );
    expect(found).toEqual([]);
  });

  it('draws no word about waiting', () => {
    const found = FILES.flatMap(({ path, source }) => {
      const findings: string[] = [];
      if (/<Loading\b[^>]*\btext=/.test(source)) findings.push(`${path}: <Loading text=…>`);
      if (/['"`][\w.]*\.loading['"`]/.test(source)) findings.push(`${path}: a *.loading copy key`);
      return findings;
    });
    expect(found).toEqual([]);
  });

  it('keeps "Loading" out of the locales', () => {
    const found: string[] = [];
    for (const locale of ['en', 'es']) {
      const raw = readFileSync(join(ROOT, 'src/shared/i18n/locales', `${locale}.json`), 'utf8');
      const walk = (node: unknown, path: string) => {
        if (typeof node === 'string') {
          if (/\b(Loading|Cargando)\b/.test(node)) found.push(`${locale}:${path} = ${node}`);
        } else if (node !== null && typeof node === 'object') {
          for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
        }
      };
      walk(JSON.parse(raw), '');
    }
    // Names of tools the model calls (`Loading tools`, `Loading chats`) are what the
    // AGENT is doing, not a screen waiting.
    expect(found.filter((entry) => !/loadTools|listAccountChats/.test(entry))).toEqual([]);
  });
});
