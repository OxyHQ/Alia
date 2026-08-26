import { readdirSync, readFileSync } from 'node:fs';
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

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every source file of the app, minus the installed packages and this gate. */
function sources(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.tsx?$/.test(entry.name) && path !== fileURLToPath(import.meta.url)) {
        found.push(path);
      }
    }
  };
  walk(APP);
  return found;
}

/**
 * Comments are stripped before matching, so the layout may keep SAYING which
 * hosts it deliberately does not mount — naming the trap is how the next
 * person avoids it, and a gate that forbade the words would delete the warning
 * along with the bug.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Read once for the whole file, not once per host: the walk plus a read of
 * every source file is the expensive half, and it does not depend on which
 * host is being looked for.
 */
const SOURCES = sources().map((path) => ({
  path: relative(APP, path),
  code: withoutComments(readFileSync(path, 'utf8')),
}));

describe('overlay hosts', () => {
  it.each(HOSTS)('the app mounts no <%s> of its own', (host) => {
    const mount = new RegExp(`<${host}[\\s/>]`);

    expect(SOURCES.filter(({ code }) => mount.test(code)).map(({ path }) => path)).toEqual([]);
  });
});
