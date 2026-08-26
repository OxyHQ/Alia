import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `OxyProvider` mounts BOTH overlay hosts for us: a `<ToastOutlet>`, and a
 * `<SurfaceProvider>` whose job is to render `<SurfaceHost>` next to its
 * children. Mounting either one again inside that tree does not "make sure" it
 * is there — both read the same module-level store, so a second host renders
 * EVERY surface twice.
 *
 * That was not theoretical: `app/_layout.tsx` carried its own `<SurfaceHost/>`,
 * so every `confirm()` / `alert()` / `prompt()` drew two panels over two
 * backdrops. Measured in a browser, the two `[role="dialog"]` nodes shared the
 * same rect and ran independent CSS animations, which is what made the dialog
 * feel wrong on the way in and on the way out while a hand-mounted `<Dialog>`
 * next to it felt fine.
 *
 * The duplicate is invisible in review — one extra self-closing tag in a
 * 100-line layout — and nothing else fails when it is there, so this is where
 * it is written down.
 */

const HOSTS = ['SurfaceHost', 'ToastOutlet'] as const;

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set([
  'node_modules',
  '.expo',
  'dist',
  'android',
  'ios',
  'public',
  'assets',
]);

/** Every `.ts`/`.tsx` file the app owns, except this gate itself. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, found);
    } else if (/\.tsx?$/.test(entry) && path !== fileURLToPath(import.meta.url)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Comments are stripped before matching, so the layout may keep SAYING which
 * hosts it deliberately does not mount — naming the trap is how the next
 * person avoids it, and a gate that forbids the words would delete the warning
 * along with the bug.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('overlay hosts', () => {
  it.each(HOSTS)('the app mounts no <%s> of its own', (host) => {
    const mounts = sourceFiles(APP_ROOT)
      .filter((path) => new RegExp(`<${host}[\\s/>]`).test(withoutComments(readFileSync(path, 'utf8'))))
      .map((path) => relative(APP_ROOT, path));

    expect(mounts).toEqual([]);
  });
});
