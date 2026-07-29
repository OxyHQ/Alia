#!/usr/bin/env node
/**
 * Guards the root-entry / voice-entry split.
 *
 * `@alia.onl/sdk` ships raw source, so a consumer's Metro compiles whatever the
 * root entry can reach. The `./voice` entry exists precisely so a text-chat
 * consumer never compiles `livekit-client` (~1.2 MB raw / ~250 KiB gzip). That
 * split is nominal unless something enforces it: v4.0.0 moved the voice exports
 * out of the root barrel, and a single deep `import` in AliaChatContent quietly
 * put livekit back in every text consumer's graph anyway.
 *
 * This walks the real import graph from each entry and asserts:
 *   - `src/index.ts` cannot reach `livekit-client`
 *   - `src/voice.ts` still can (otherwise the voice surface has been gutted and
 *     the first assertion would pass for the wrong reason)
 *
 * Type-only imports are ignored — they are erased before the bundler sees them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const HEAVY_MODULE = 'livekit-client';
/** Below this, the walker itself is broken and a "pass" would be meaningless. */
const MIN_MODULES_FROM_ROOT = 20;

const EXTENSIONS = ['.tsx', '.ts'];
const PLATFORM_SUFFIXES = ['', '.native', '.web', '.ios', '.android'];

/** Matches `import … from 'x'`, `export … from 'x'`, `import 'x'`, `import('x')`. */
const SPECIFIER_PATTERN =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every on-disk file a relative specifier can resolve to, platform forks included. */
function resolveRelative(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const resolved = [];
  for (const suffix of PLATFORM_SUFFIXES) {
    for (const extension of EXTENSIONS) {
      const direct = `${base}${suffix}${extension}`;
      if (fs.existsSync(direct)) resolved.push(direct);
      const asIndex = path.join(base, `index${suffix}${extension}`);
      if (fs.existsSync(asIndex)) resolved.push(asIndex);
    }
  }
  return resolved;
}

/** Breadth-first walk of runtime imports; returns the graph and any paths to `target`. */
function walk(entry, target) {
  const start = path.join(SRC, entry);
  const visited = new Set([start]);
  const importedBy = new Map();
  const queue = [start];
  const hits = [];

  while (queue.length > 0) {
    const file = queue.shift();
    const source = fs.readFileSync(file, 'utf8');

    for (const match of source.matchAll(SPECIFIER_PATTERN)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      if (/^\s*(?:import|export)\s+type\s/.test(match[0])) continue;

      if (specifier === target || specifier.startsWith(`${target}/`)) {
        hits.push(file);
        continue;
      }
      if (!specifier.startsWith('.')) continue;

      for (const next of resolveRelative(file, specifier)) {
        if (visited.has(next)) continue;
        visited.add(next);
        importedBy.set(next, file);
        queue.push(next);
      }
    }
  }

  return { visited, importedBy, hits };
}

function chainTo(file, importedBy) {
  const chain = [];
  for (let current = file; current; current = importedBy.get(current)) {
    chain.unshift(path.relative(SRC, current));
  }
  return chain.join(' -> ');
}

const root = walk('index.ts', HEAVY_MODULE);
const voice = walk('voice.ts', HEAVY_MODULE);
const failures = [];

if (root.visited.size < MIN_MODULES_FROM_ROOT) {
  failures.push(
    `Only ${root.visited.size} modules reachable from src/index.ts (expected at least ` +
      `${MIN_MODULES_FROM_ROOT}) — the import walker is broken, so this check proves nothing.`,
  );
}

if (root.hits.length > 0) {
  failures.push(
    `src/index.ts reaches ${HEAVY_MODULE}. Text-chat consumers must not compile it — ` +
      `move the import behind the ./voice entry.\n` +
      root.hits.map((file) => `    ${chainTo(file, root.importedBy)}`).join('\n'),
  );
}

if (voice.hits.length === 0) {
  failures.push(
    `src/voice.ts no longer reaches ${HEAVY_MODULE}. Either the voice surface was ` +
      `removed or the walker stopped resolving — either way the root-entry check above ` +
      `is passing for the wrong reason.`,
  );
}

if (failures.length > 0) {
  console.error('Entry isolation check FAILED:\n');
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log(
  `Entry isolation OK — ${HEAVY_MODULE} is unreachable from src/index.ts ` +
    `(${root.visited.size} modules walked) and reachable from src/voice.ts.`,
);
