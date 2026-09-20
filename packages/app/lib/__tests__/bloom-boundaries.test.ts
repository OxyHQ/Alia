import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * How the app is allowed to reach Bloom, asserted rather than remembered.
 *
 * #608 §4 asks for "reglas de dependencias/imports en CI: … sin imports
 * privados de Bloom", and §11 for "consumir Bloom mediante subpaths públicos,
 * respetando los bindings `.web`/native y los peers opcionales. No importar
 * `Bloom/src`, archivos internos o el código del template desde otra ruta del
 * monorepo."
 *
 * Both of those are one-line mistakes that typecheck, render, and are invisible
 * in review — which is what a gate is for. This one is deliberately narrow: it
 * asserts the SHAPE of the dependency, not a list of which components are
 * allowed, because a list would need editing every time the app adopts one more
 * and would therefore be edited without thought.
 *
 * ## Why each rule
 *
 * **Public subpaths only.** `@oxy.so/bloom/<family>` is the contract. Reaching
 * `@oxy.so/bloom/lib/module/...` or `@oxy.so/bloom/src/...` gets a file that is
 * not exported, is not the platform-correct binding, and can move in a patch
 * release. It also silently skips the `.web`/native fork: `exports` picks
 * `AiChat.web` on the browser and `AiChat` on a device, and a deep path picks
 * whichever one it named.
 *
 * **Never the library's repository.** Bloom is a published package. An import
 * that reaches a sibling checkout — `Bloom/src`, `../../../Bloom`, the template
 * — compiles on the machine that has it and nowhere else, and pins the app to
 * whatever is uncommitted in someone's working tree. The adoption matrix
 * records that the local checkout is 1.5 majors behind what is published.
 *
 * The companion rule — that the app keeps no local re-implementation of a
 * Bloom family — lives with the retirement that makes it true, in
 * `docs/ui-layer-retirement.mdx` and its own gate. Asserting it here while ten
 * such wrappers still exist would be committing a failing test and calling it
 * a plan.
 */

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = fileURLToPath(import.meta.url);

/** Every source file of the app, minus the installed packages and this gate. */
function sources(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.tsx?$/.test(entry.name) && path !== SELF) {
        found.push(path);
      }
    }
  };
  walk(APP);
  return found;
}

interface Offence {
  file: string;
  specifier: string;
}

/** Every module specifier the app imports, with the file that imports it. */
function imports(): Offence[] {
  const found: Offence[] = [];
  for (const file of sources()) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import\(|require\()\s*['"]([^'"]+)['"]/g)) {
      found.push({ file: relative(APP, file), specifier: match[1] });
    }
  }
  return found;
}

const ALL = imports();

describe('Bloom is consumed through its public subpaths', () => {
  it('reaches no compiled or source file inside the package', () => {
    const deep = ALL.filter(({ specifier }) =>
      /^@oxy\.so\/bloom\/(lib|src)\b/.test(specifier));

    expect(deep).toEqual([]);
  });

  it('never reaches the library\'s own repository', () => {
    // A relative path climbing out of this package, or any specifier naming the
    // Bloom checkout. Either compiles only where that checkout exists.
    const sibling = ALL.filter(({ specifier }) =>
      /(^|[\\/])Bloom[\\/]/.test(specifier) || /\.\.[\\/]\.\.[\\/]\.\.[\\/]Bloom/.test(specifier));

    expect(sibling).toEqual([]);
  });

  it('imports only subpaths the package actually exports', () => {
    const declared = Object.keys(
      JSON.parse(
        readFileSync(join(APP, '..', '..', 'node_modules', '@oxy.so', 'bloom', 'package.json'), 'utf8'),
      ).exports,
    ).map((key) => key.replace(/^\.\/?/, ''));

    const literal = new Set(declared.filter((key) => !key.includes('*')));
    /**
     * Bloom declares its glyphs as a pattern, not as a thousand keys:
     * `"./icons/Ri*"`. A gate that only compared literal keys would call every
     * per-glyph import unknown — which is backwards, since importing
     * `@oxy.so/bloom/icons/RiChat3Line` instead of the barrel is the point of
     * that pattern and is what stops an app shipping all 1,747 of them.
     */
    const patterns = declared
      .filter((key) => key.includes('*'))
      .map((key) => new RegExp(`^${key.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`));

    const unknown = ALL
      .filter(({ specifier }) => specifier.startsWith('@oxy.so/bloom'))
      .map(({ file, specifier }) => ({
        file,
        specifier,
        subpath: specifier.replace(/^@oxy\.so\/bloom\/?/, ''),
      }))
      .filter(({ subpath }) =>
        subpath !== ''
        && !literal.has(subpath)
        && !patterns.some((pattern) => pattern.test(subpath)));

    expect(unknown).toEqual([]);
  });
});
