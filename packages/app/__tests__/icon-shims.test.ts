/**
 * The web icon-barrel shims have to stay ahead of the source that imports them.
 *
 * `metro.config.js` resolves `lucide-react-native` and `@radix-ui/react-icons`
 * to hand-scoped barrels on web (see `docs/bundle-baseline.mdx`: 2,139,962 B off
 * `index-*.js`). TypeScript cannot guard this — `tsc` resolves both specifiers
 * to the real packages and never sees a shim — so an icon added to a component
 * and forgotten here compiles clean and renders `undefined` in the browser.
 * This test is the guard: it re-runs the scan and compares it to what the shims
 * export.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APP_ROOT,
  LUCIDE_SHIM,
  renderLucideShim,
  scanBareImports,
  scanLucideImports,
} from '../scripts/icon-shims.mjs';
import { join } from 'node:path';

describe('web icon-barrel shims', () => {
  it('lucide shim matches what the source imports', () => {
    const scan = scanLucideImports();
    expect(scan.namespaceImports).toEqual([]);
    // A floor that proves the scan found the source at all, not a target: the
    // count only falls as screens move to Bloom's Remix icons.
    expect(scan.icons.length).toBeGreaterThan(5);
    // Byte-comparing against a fresh render catches a missing icon, a stale
    // icon and a hand edit in one assertion.
    expect(readFileSync(LUCIDE_SHIM, 'utf8')).toBe(renderLucideShim(scan));
  });

  it('lucide shim imports subpaths only, never the root barrel it replaces', () => {
    const shim = readFileSync(LUCIDE_SHIM, 'utf8');
    const valueImports = [...shim.matchAll(/^export \{[^}]*\} from '([^']+)';$/gm)].map((m) => m[1]);
    expect(valueImports.length).toBeGreaterThan(0);
    for (const specifier of valueImports) {
      expect(specifier).toMatch(/^lucide-react-native\/icons\//);
    }
  });

  it('radix shim covers every icon the source imports from @radix-ui/react-icons', () => {
    const shim = readFileSync(join(APP_ROOT, 'lib/shims/radix-icons.tsx'), 'utf8');
    const exported = new Set(
      [...shim.matchAll(/^export const (\w+) = radixIcon\(/gm)].map((m) => m[1]),
    );
    const scan = scanBareImports('@radix-ui/react-icons');
    expect(scan.namespaceImports).toEqual([]);
    expect(scan.names.length).toBeGreaterThan(0);
    expect(scan.names.filter((n) => !exported.has(n))).toEqual([]);
  });
});
