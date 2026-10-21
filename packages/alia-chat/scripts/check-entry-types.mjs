#!/usr/bin/env node
/**
 * Every entry in `exports` must type-check on its own, in a consumer that loads nothing globally.
 *
 * `@alia.onl/sdk` ships raw source, so a consumer's compiler type-checks whatever an entry
 * reaches, with the consumer's options. The SDK's own `tsc` cannot see an entry that leans on
 * something only ANOTHER entry brings into the program: its project includes every file at once.
 *
 * That is how 21.4.0–21.5.2 shipped `/text` and `/ask/text`: the SDK's components use NativeWind's
 * `className` on React Native views, a prop that exists only once `nativewind/types` augments
 * React Native's types, and only `src/index.ts` carried that reference. Expo apps load NativeWind's
 * types themselves and never noticed; a Vite consumer importing `@alia.onl/sdk/text` (the website)
 * got 65 `className` errors. So each entry that reaches a component carries its own
 * `/// <reference types="nativewind/types" />` (a triple-slash directive in a shipped `.ts` file
 * is what a consumer's compiler reads), and this check holds it.
 *
 * For each entry it writes a throwaway consumer outside the repo whose `node_modules/@alia.onl/sdk`
 * is a symlink to this package — so the `exports` map is resolved exactly as for an installed
 * package — and compiles one file that imports only that entry, with `types: []` (nothing loaded
 * globally: no NativeWind, no Node, no Vite) and the strict options of the strictest consumer we
 * have (the website: `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUncheckedSideEffectImports`).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const TSC = createRequire(path.join(PACKAGE_ROOT, 'package.json')).resolve('typescript/bin/tsc');

const COMPILER_OPTIONS = {
  target: 'ES2023',
  lib: ['ES2023', 'DOM', 'DOM.Iterable'],
  module: 'ESNext',
  moduleResolution: 'bundler',
  moduleDetection: 'force',
  jsx: 'react-jsx',
  types: [],
  skipLibCheck: true,
  strict: true,
  verbatimModuleSyntax: true,
  erasableSyntaxOnly: true,
  noUncheckedSideEffectImports: true,
  noEmit: true,
};

const entries = Object.keys(manifest.exports ?? {})
  .filter((key) => key !== './package.json')
  .map((key) => (key === '.' ? manifest.name : `${manifest.name}/${key.slice(2)}`));

if (entries.length < 2) {
  console.error(
    `check:entry-types: found ${entries.length} entries in exports; the walker is broken.`,
  );
  process.exit(1);
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'alia-sdk-entry-types-'));

function compile(entry) {
  const slug = entry.replace(/[^a-z0-9]+/gi, '-');
  const project = path.join(dir, slug);
  mkdirSync(project);
  writeFileSync(path.join(project, 'consumer.ts'), `export * from '${entry}';\n`);
  writeFileSync(
    path.join(project, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: COMPILER_OPTIONS, files: ['consumer.ts'] }),
  );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSC, '-p', project, '--pretty', 'false'], {
      cwd: dir,
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (code) => resolve({ entry, code, output }));
  });
}

let failed = 0;
try {
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'probe', private: true }));
  mkdirSync(path.join(dir, 'node_modules', '@alia.onl'), { recursive: true });
  symlinkSync(PACKAGE_ROOT, path.join(dir, 'node_modules', ...manifest.name.split('/')), 'dir');

  const queue = [...entries];
  const results = [];
  const workers = Array.from({ length: Math.min(4, os.availableParallelism()) }, async () => {
    while (queue.length > 0) results.push(await compile(queue.shift()));
  });
  await Promise.all(workers);

  for (const { entry, code, output } of results.sort((a, b) => a.entry.localeCompare(b.entry))) {
    if (code === 0) {
      console.log(`ok   ${entry}`);
      continue;
    }
    failed += 1;
    const errors = output.split('\n').filter((line) => line.includes('error TS'));
    console.error(`FAIL ${entry}: ${errors.length} type error(s) in a consumer importing only it`);
    for (const line of errors.slice(0, 10)) {
      console.error(`     ${line.replace(PACKAGE_ROOT, '<sdk>')}`);
    }
    if (errors.length === 0) console.error(output);
    if (errors.some((line) => line.includes("'className'"))) {
      console.error(
        '     `className` comes from NativeWind: the entry needs its own ' +
          '`/// <reference types="nativewind/types" />`.',
      );
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(
    `check:entry-types: ${failed} of ${entries.length} entries do not type-check alone.`,
  );
  process.exit(1);
}
console.log(`check:entry-types: all ${entries.length} entries type-check alone.`);
