import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { APP_ROOT } from '@/shared/testing/app-root';

/**
 * The app takes values from `@oxy.so/contracts/client`, never from the root entry.
 *
 * The root is the API's contract: every Zod schema and Zod itself. One value import from it
 * (`oxyAccountIdSchema`, to brand the account id of a checkout) linked 984 KB into the JS every
 * route loads before it is usable: Zod 540 KB and the root's schemas 444 KB. `@oxy.so/core` and
 * `@oxy.so/services` already use only the client entry, whose checks are tied to those schemas by
 * contracts' parity test. Types may still come from the root: `import type` is erased.
 */
const SKIP = new Set(['node_modules', 'dist', '__tests__', '.expo']);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** Each `import … from '@oxy.so/contracts'` (or `export … from`) that brings a value. */
function rootValueImports(source: string): string[] {
  const statements = source.match(/(?:import|export)\s[^;]*?\sfrom\s+['"]@oxy\.so\/contracts['"]/g);
  return (statements ?? []).filter((statement) => {
    if (/^(?:import|export)\s+type\s/.test(statement)) return false;
    const names = /\{([^}]*)\}/.exec(statement)?.[1];
    // `import { type A, type B }` brings no value either.
    return !names || names.split(',').some((name) => name.trim() && !/^type\s/.test(name.trim()));
  });
}

it('imports no value from the root of @oxy.so/contracts', () => {
  const offenders = [join(APP_ROOT, 'src'), join(APP_ROOT, 'app')]
    .flatMap(sources)
    .filter((file) => rootValueImports(readFileSync(file, 'utf8')).length)
    .map((file) => relative(APP_ROOT, file));
  expect(offenders).toEqual([]);
});

it('tells a value import from a type-only one (the control)', () => {
  expect(
    rootValueImports("import { type A, oxyAccountIdSchema } from '@oxy.so/contracts';"),
  ).toHaveLength(1);
  expect(rootValueImports("import type { A } from '@oxy.so/contracts';")).toHaveLength(0);
  expect(rootValueImports("import { type A, type B } from '@oxy.so/contracts';")).toHaveLength(0);
  expect(
    rootValueImports("import { parseContract } from '@oxy.so/contracts/client';"),
  ).toHaveLength(0);
});
