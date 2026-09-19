#!/usr/bin/env node
/**
 * The published package must be usable from a CommonJS TypeScript backend.
 *
 * ## What went wrong, and why nothing here caught it
 *
 * 1.0.0 shipped `exports["."] = { types, import, require }` — one `types` entry
 * for both conditions, pointing at `dist/index.d.ts`. That file sits in a
 * package whose `type` is `module`, so TypeScript reads it as an ES module
 * declaration. Under `moduleResolution: node16`, a CommonJS importer therefore
 * got **TS1479**: *"the referenced file is an ECMAScript module and cannot be
 * imported with `require`"* — while the RUNTIME resolution was perfectly
 * correct, because Node read `require` → `dist/index.cjs` and never looked at
 * the types at all.
 *
 * That is the whole trap: this package's own `typecheck`, `test` and `build`
 * all passed, and so did every consumer that used a bundler. The first consumer
 * whose `tsconfig` says `module: Node16` — Homiio's Express API, which is the
 * reason this package exists — could not compile against it.
 *
 * So the gate below does not check the source. It checks the SHIPPED SHAPE:
 * that each condition carries its own `types`, that every referenced file
 * exists, that the CommonJS declaration is the `.d.cts` one, and that both
 * entry points actually load and export the same surface. A declaration file
 * that a consumer's compiler rejects is not a type error anybody here can see;
 * it is a packaging error, and this is where packaging errors get caught.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(PACKAGE_ROOT, 'package.json'));
const manifest = require('./package.json');

/** Everything a consumer is entitled to import by name. */
const REQUIRED_EXPORTS = [
  'ALIA_API_URL',
  'AliaAbortError',
  'AliaRequestError',
  'AliaServerClient',
  'AliaStreamError',
  'createAliaServerClient',
  'readAliaEventStream',
];

const problems = [];

const root = manifest.exports?.['.'];
if (root === undefined || typeof root !== 'object') {
  problems.push('package.json exports has no "." entry.');
} else {
  for (const condition of ['import', 'require']) {
    const entry = root[condition];
    if (entry === undefined || typeof entry !== 'object') {
      problems.push(
        `exports["."].${condition} must be an object carrying its OWN "types" — a single ` +
          'shared "types" is what shipped TS1479 to every CommonJS consumer of 1.0.0.',
      );
      continue;
    }
    for (const field of ['types', 'default']) {
      const file = entry[field];
      if (typeof file !== 'string') {
        problems.push(`exports["."].${condition}.${field} is missing.`);
        continue;
      }
      if (!existsSync(path.join(PACKAGE_ROOT, file))) {
        problems.push(`exports["."].${condition}.${field} points at ${file}, which does not exist. Run the build.`);
      }
    }
  }

  // `type: module` makes a bare `.d.ts` an ESM declaration. The CommonJS
  // condition must therefore name the `.d.cts`, or a `node16` consumer is told
  // to `import()` a package it is requiring correctly.
  if (manifest.type === 'module' && root.require?.types !== undefined && !String(root.require.types).endsWith('.d.cts')) {
    problems.push(
      `exports["."].require.types is ${root.require.types}; in a "type": "module" package the ` +
        'CommonJS declaration must be a .d.cts file.',
    );
  }
  if (root.import?.types !== undefined && !String(root.import.types).endsWith('.d.ts')) {
    problems.push(`exports["."].import.types is ${root.import.types}; it must be the .d.ts file.`);
  }
}

if (typeof manifest.types === 'string' && !existsSync(path.join(PACKAGE_ROOT, manifest.types))) {
  problems.push(`"types" points at ${manifest.types}, which does not exist.`);
}

// Both entry points must LOAD. A correct exports map over a broken build is
// still a broken package.
let loaded = 0;
try {
  const cjs = require('./dist/index.cjs');
  loaded += 1;
  for (const name of REQUIRED_EXPORTS) {
    if (cjs[name] === undefined) problems.push(`dist/index.cjs does not export ${name}.`);
  }
} catch (error) {
  problems.push(`require("./dist/index.cjs") threw: ${error.message}`);
}

try {
  const esm = await import(new URL('./dist/index.js', `file://${PACKAGE_ROOT}/`).href);
  loaded += 1;
  for (const name of REQUIRED_EXPORTS) {
    if (esm[name] === undefined) problems.push(`dist/index.js does not export ${name}.`);
  }
} catch (error) {
  problems.push(`import("./dist/index.js") threw: ${error.message}`);
}

if (loaded !== 2) problems.push(`Only ${loaded} of 2 entry points loaded.`);

/**
 * The assertions above encode the RULE. This compiles the actual consumer.
 *
 * A CommonJS TypeScript file under `module: node16` — Homiio's backend, exactly
 * — importing this package by name. TS1479 is what 1.0.0 produced here, and no
 * amount of reasoning about exports maps is worth as much as the compiler
 * saying so.
 */
try {
  const { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const { spawnSync } = await import('node:child_process');

  const dir = mkdtempSync(path.join(os.tmpdir(), 'alia-server-cjs-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'probe', private: true }));
    // A REAL node_modules layout, not a `paths` alias: TypeScript applies a
    // package's `exports` map only when it resolves through node_modules, so a
    // `paths` probe would have compiled the broken 1.0.0 shape clean and proved
    // nothing at all. (It did, while this was being written.)
    mkdirSync(path.join(dir, 'node_modules', '@alia.onl'), { recursive: true });
    symlinkSync(PACKAGE_ROOT, path.join(dir, 'node_modules', '@alia.onl', 'server'), 'dir');
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'Node16',
          moduleResolution: 'node16',
          target: 'ES2022',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        files: ['probe.ts'],
      }),
    );
    writeFileSync(
      path.join(dir, 'probe.ts'),
      "import { AliaServerClient, type AliaStreamEvent } from '@alia.onl/server';\n" +
        'export const probe = (client: AliaServerClient, event: AliaStreamEvent): string =>\n' +
        "  event.type === 'text' ? event.text : client.url;\n",
    );

    const tsc = require.resolve('typescript/bin/tsc');
    const result = spawnSync(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json')], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      problems.push(
        'A CommonJS consumer (module: node16) cannot compile against this package:\n' +
          `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} catch (error) {
  problems.push(`the CommonJS consumer probe could not run: ${error.message}`);
}

if (problems.length > 0) {
  console.error('check-entrypoints FAILED:\n');
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

console.log(
  `check-entrypoints: OK — both conditions carry their own types, all four files exist, ` +
    `and each entry point exports all ${REQUIRED_EXPORTS.length} names.`,
);
