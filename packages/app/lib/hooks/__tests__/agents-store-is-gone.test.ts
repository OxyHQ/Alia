import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The agent store is gone, and stays gone.
 *
 * It held `agents`, `loading`, `error` and `total` — a hand-maintained copy of
 * the server's list, sitting beside a TanStack query that read the same
 * endpoint. Two caches of one thing is why a write through one could not tell
 * the other, and why a new agent did not appear in the sidebar. Reintroducing
 * one anywhere brings the bug back whole, so "there is one source" is asserted
 * rather than remembered.
 */

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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
 * Built rather than written out, so the gate does not match ITSELF and report a
 * reference that is only the description of one.
 */
const STORE_HOOK = ['useAgents', 'Store'].join('');
const STORE_MODULE = ['stores/agents', 'store'].join('-');

describe('the agents store', () => {
  it('no longer exists as a module', () => {
    expect(existsSync(join(APP, 'lib', 'stores', 'agents-store.ts'))).toBe(false);
  });

  it('is named by nothing that runs', () => {
    const files = sources();
    // Positive control on the walker: an empty list would satisfy every
    // assertion below it without reading a single file.
    expect(files.length).toBeGreaterThan(100);

    const offenders = files
      .filter((path) => {
        const source = readFileSync(path, 'utf8');
        // Prose may still explain what was removed and why; an IMPORT of it may
        // not exist.
        return source.includes(STORE_HOOK) || source.includes(`'@/lib/${STORE_MODULE}'`);
      })
      .map((path) => relative(APP, path));

    expect(offenders).toEqual([]);
  });

  it('would catch a reference if one came back', () => {
    // The same predicate against the thing it exists to reject.
    const reintroduced = `import { ${STORE_HOOK} } from '@/lib/${STORE_MODULE}';`;

    expect(reintroduced.includes(STORE_HOOK)).toBe(true);
  });
});
