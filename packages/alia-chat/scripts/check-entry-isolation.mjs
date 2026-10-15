#!/usr/bin/env node
/**
 * Guards the root entry's dependencies.
 *
 * `@alia.onl/sdk` ships raw source, so a consumer's Metro compiles whatever the
 * root entry can reach. Since 16.0.0 the voice call is part of the conversation
 * screen (`AliaChatContent`), so the root entry reaches it — but only through
 * ONE lazy `import()` in `components/voice/AliaVoiceCall.tsx`, so nothing of the
 * call or its audio engine is evaluated until the first call. This check holds
 * that the root entry does reach the call that way (and that the walker works),
 * that `./voice` still reaches it, and the retired modules stay out of both.
 *
 * It was built to keep `livekit-client` (~1.2 MB raw / ~250 KiB gzip) out of
 * text consumers. LiveKit is gone since 8.0.0, and device speech recognition
 * (`expo-speech-recognition`) since 15.0.0; both stay out of both entries.
 * Since 15.0.0 the call's audio engine is `react-native-audio-api`, a native
 * module a text consumer must never have to install or build.
 *
 * This walks the real import graph from each entry and asserts:
 *   - neither entry reaches `livekit-client` or `expo-speech-recognition`
 *   - `src/index.ts` cannot reach the voice call (`hooks/useVoiceRoom.ts`) nor
 *     its audio engine (`react-native-audio-api`)
 *   - `src/voice.ts` still reaches both (otherwise the voice surface has been
 *     gutted and the previous assertions would pass for the wrong reason)
 *
 * It also holds that neither entry imports the `@oxy.so/services` ROOT barrel:
 * that barrel re-exports every sign-in panel and the Commons QR encoder, and
 * Metro does not tree-shake, so one `useOxy` from it ships them all to every
 * consumer. `@oxy.so/services/ui/client` exports the same hooks without them.
 *
 * Type-only imports are ignored — they are erased before the bundler sees them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const RETIRED_MODULES = ['livekit-client', 'expo-speech-recognition'];
const AUDIO_ENGINE = 'react-native-audio-api';
const SERVICES_ROOT = '@oxy.so/services';
const VOICE_LOOP = path.join(SRC, 'hooks', 'useVoiceRoom.ts');
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

/**
 * Breadth-first walk of runtime imports; returns the graph and any paths to
 * `target` (the package or any of its subpaths, or with `exact`, only the bare
 * specifier itself).
 */
function walk(entry, target, { exact = false } = {}) {
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

      if (specifier === target || (!exact && specifier.startsWith(`${target}/`))) {
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

const root = walk('index.ts', RETIRED_MODULES[0]);
const failures = [];

if (root.visited.size < MIN_MODULES_FROM_ROOT) {
  failures.push(
    `Only ${root.visited.size} modules reachable from src/index.ts (expected at least ` +
      `${MIN_MODULES_FROM_ROOT}) — the import walker is broken, so this check proves nothing.`,
  );
}

for (const retired of RETIRED_MODULES) {
  for (const entry of ['index.ts', 'voice.ts', 'runtime/index.ts', 'avatar.ts']) {
    const result = walk(entry, retired);
    if (result.hits.length > 0) {
      failures.push(
        `src/${entry} reaches ${retired}, which the SDK no longer depends on. ` +
          `A call is a realtime session through Alia (hooks/useVoiceRoom.ts) and dictation ` +
          `is transcribed by Alia (hooks/useDictation.ts).\n` +
          result.hits.map((file) => `    ${chainTo(file, result.importedBy)}`).join('\n'),
      );
    }
  }
}

const voice = walk('voice.ts', AUDIO_ENGINE);
if (voice.hits.length === 0) {
  failures.push(
    `src/voice.ts no longer reaches ${AUDIO_ENGINE}. Either the call's native engine ` +
      `was removed or the walker stopped resolving platform files.`,
  );
}

for (const entry of ['index.ts', 'voice.ts', 'runtime/index.ts', 'avatar.ts']) {
  const { hits, importedBy } = walk(entry, SERVICES_ROOT, { exact: true });
  if (hits.length > 0) {
    failures.push(
      `src/${entry} imports the ${SERVICES_ROOT} root barrel, which ships every sign-in ` +
        `panel to the consumer. Import from ${SERVICES_ROOT}/ui/client instead.\n` +
        hits.map((file) => `    ${chainTo(file, importedBy)}`).join('\n'),
    );
  }
}

// `@alia.onl/sdk/runtime` is the data layer alone: nothing it reaches draws, and nothing in it
// reaches the call or its audio engine.
const runtime = walk('runtime/index.ts', AUDIO_ENGINE);
const drawn = [...runtime.visited].filter((file) =>
  path.relative(SRC, file).startsWith(`components${path.sep}`),
);
if (runtime.visited.size < 10) {
  failures.push(
    `Only ${runtime.visited.size} modules reachable from src/runtime/index.ts — the walker is broken.`,
  );
}
if (drawn.length > 0 || runtime.hits.length > 0 || runtime.visited.has(VOICE_LOOP)) {
  failures.push(
    `src/runtime/index.ts reaches the UI or the voice call. The runtime is a leaf entry ` +
      `(@alia.onl/sdk/runtime) and nothing it imports may draw.\n` +
      [...drawn, ...runtime.hits]
        .map((file) => `    ${chainTo(file, runtime.importedBy)}`)
        .join('\n'),
  );
}

// `@alia.onl/sdk/model` is the conversation as pure data: it can be read from anywhere, so
// nothing it reaches may need React, a native module or the Oxy client.
const MODEL_FORBIDDEN = [
  'react',
  'react-native',
  '@oxy.so/services',
  '@oxy.so/bloom',
  '@tanstack/react-query',
  'zustand',
  'expo-file-system',
];
const model = walk('runtime/model.ts', MODEL_FORBIDDEN[0], { exact: true });
if (model.visited.size < 8) {
  failures.push(
    `Only ${model.visited.size} modules reachable from src/runtime/model.ts — the walker is broken.`,
  );
}
// Positive control: the runtime entry, which re-exports the model, does reach React and zustand.
for (const needle of ['react', 'zustand']) {
  if (walk('runtime/index.ts', needle).hits.length === 0) {
    failures.push(
      `src/runtime/index.ts no longer reaches ${needle} — the model check proves nothing.`,
    );
  }
}
for (const forbidden of MODEL_FORBIDDEN) {
  const { hits, importedBy } = walk('runtime/model.ts', forbidden);
  if (hits.length > 0) {
    failures.push(
      `src/runtime/model.ts reaches ${forbidden}. The model is a pure leaf entry (@alia.onl/sdk/model).\n` +
        hits.map((file) => `    ${chainTo(file, importedBy)}`).join('\n'),
    );
  }
}

if (!root.visited.has(VOICE_LOOP)) {
  failures.push(
    `src/index.ts no longer reaches the voice call (hooks/useVoiceRoom.ts). The conversation ` +
      `screen includes the call; if it was removed or the walker stopped resolving, say so here.`,
  );
}

if (!voice.visited.has(VOICE_LOOP)) {
  failures.push(
    `src/voice.ts no longer reaches hooks/useVoiceRoom.ts. Either the voice surface was ` +
      `removed or the walker stopped resolving.`,
  );
}

/**
 * The avatar leaf stays a leaf: reaching the conversation UI from it would put the whole chat in
 * the entry bundle of every app that only wants her face on a button.
 */
const avatar = walk('avatar.ts', RETIRED_MODULES[0]);
if (avatar.visited.size < 5) {
  failures.push(
    `Only ${avatar.visited.size} modules reachable from src/avatar.ts — the walker is broken or the entry was gutted.`,
  );
}
for (const heavy of [
  path.join(SRC, 'components', 'AliaChatContent.tsx'),
  path.join(SRC, 'components', 'AliaChatSheet.tsx'),
  path.join(SRC, 'components', 'Markdown.tsx'),
  path.join(SRC, 'hooks', 'useVoiceRoom.ts'),
]) {
  if (avatar.visited.has(heavy)) {
    failures.push(
      `src/avatar.ts reaches ${path.relative(SRC, heavy)}: ${chainTo(heavy, avatar.importedBy)}. ` +
        'The avatar entry must not reach the chat.',
    );
  }
}

if (failures.length > 0) {
  console.error('Entry isolation check FAILED:\n');
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log(
  `Entry check OK — the voice call and ${AUDIO_ENGINE} are reachable from src/index.ts ` +
    `(${root.visited.size} modules walked) and src/voice.ts; ` +
    `${RETIRED_MODULES.join(' and ')} are reachable from neither.`,
);
