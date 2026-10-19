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
 * And it holds that on WEB the SDK draws no async chunk boundary of its own, but the one of
 * `@alia.onl/sdk/ask`. Metro's web serializer hoists every module two async chunks share into
 * `__common.js`, an unconditional `<script>` loaded at first paint. An `import()` inside the SDK
 * makes a second chunk next to the app's own: an app that lazy-loads its Alia sheet (the root
 * entry, behind its own `import()`) then got the whole chat and the Bloom it draws with in its
 * first paint (21.3.x: ~770 KB of SDK plus ~1.7 MB of Bloom moved into `__common`). So every
 * native-only lazy load has a `.web` fork that imports statically, and the web walk below
 * resolves files the way Metro does for web (`x.web.tsx` before `x.tsx`).
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

/**
 * Every on-disk file a relative specifier can resolve to, platform forks included; with
 * `platform: 'web'`, the one file Metro picks for web (`.web` fork first, then the plain file).
 */
function resolveRelative(fromFile, specifier, platform) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  if (platform === 'web') {
    for (const stem of [base, path.join(base, 'index')]) {
      for (const extension of EXTENSIONS) {
        for (const suffix of ['.web', '']) {
          const candidate = `${stem}${suffix}${extension}`;
          if (fs.existsSync(candidate)) return [candidate];
        }
      }
    }
    return [];
  }
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
 * Breadth-first walk of runtime imports; returns the graph, any paths to
 * `target` (the package or any of its subpaths, or with `exact`, only the bare
 * specifier itself) and every lazy `import()` it met (`dynamic`).
 */
function walk(entry, target, { exact = false, staticOnly = false, platform } = {}) {
  const start = path.join(SRC, entry);
  const visited = new Set([start]);
  const importedBy = new Map();
  const queue = [start];
  const hits = [];
  const dynamic = [];

  while (queue.length > 0) {
    const file = queue.shift();
    const source = fs.readFileSync(file, 'utf8');

    for (const match of source.matchAll(SPECIFIER_PATTERN)) {
      // A lazy `import()` is a boundary when the question is what an entry LOADS with it.
      if (staticOnly && match[3]) continue;
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      if (/^\s*(?:import|export)\s+type\s/.test(match[0])) continue;
      if (match[3]) dynamic.push({ file, specifier });

      if (specifier === target || (!exact && specifier.startsWith(`${target}/`))) {
        hits.push(file);
        continue;
      }
      if (!specifier.startsWith('.')) continue;

      for (const next of resolveRelative(file, specifier, platform)) {
        if (visited.has(next)) continue;
        visited.add(next);
        importedBy.set(next, file);
        queue.push(next);
      }
    }
  }

  return { visited, importedBy, hits, dynamic };
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
  for (const entry of ['index.ts', 'voice.ts', 'runtime/index.ts', 'avatar.ts', 'ask.ts']) {
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

for (const entry of ['index.ts', 'voice.ts', 'runtime/index.ts', 'avatar.ts', 'ask.ts']) {
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

/**
 * The ask leaves (`@alia.onl/sdk/ask`, and `@alia.onl/sdk/ask/text` without the call) are what an
 * app mounts at its root: the provider and its hook. The sheet each opens is loaded with the first
 * `ask`, through ONE lazy `import()`, so nothing of the chat is loaded WITH the entry.
 */
const ASK_SHEET = path.join(SRC, 'components', 'AliaAskSheet.tsx');
const ASK_ENTRIES = [
  {
    entry: 'ask.ts',
    boundary: {
      file: path.join(SRC, 'components', 'AliaAskProviderLazy.tsx'),
      specifier: './AliaAskSheetWithVoice',
    },
  },
  {
    entry: 'ask-text.ts',
    boundary: {
      file: path.join(SRC, 'components', 'AliaAskProviderText.tsx'),
      specifier: './AliaAskSheet',
    },
  },
];
for (const { entry } of ASK_ENTRIES) {
  const askStatic = walk(entry, RETIRED_MODULES[0], { staticOnly: true });
  if (askStatic.visited.size < 2) {
    failures.push(
      `Only ${askStatic.visited.size} modules reachable from src/${entry} — the walker is broken or the entry was gutted.`,
    );
  }
  for (const heavy of [
    ASK_SHEET,
    path.join(SRC, 'components', 'AliaAskSheetWithVoice.tsx'),
    path.join(SRC, 'components', 'AliaChatContent.tsx'),
    path.join(SRC, 'components', 'AliaChatSheet.tsx'),
    path.join(SRC, 'components', 'Markdown.tsx'),
    path.join(SRC, 'hooks', 'useVoiceRoom.ts'),
  ]) {
    if (askStatic.visited.has(heavy)) {
      failures.push(
        `src/${entry} loads ${path.relative(SRC, heavy)} with the entry: ` +
          `${chainTo(heavy, askStatic.importedBy)}. The sheet must arrive with the first \`ask\`.`,
      );
    }
  }
  // Positive control: through its lazy import, the ask entry does reach the sheet and the chat.
  const askLazy = walk(entry, RETIRED_MODULES[0]);
  if (
    !askLazy.visited.has(ASK_SHEET) ||
    !askLazy.visited.has(path.join(SRC, 'components', 'AliaChatSheet.tsx'))
  ) {
    failures.push(
      `src/${entry} no longer reaches components/AliaAskSheet.tsx and the chat sheet through its ` +
        'lazy import — the sheet was removed or the walker stopped resolving.',
    );
  }
}

/**
 * The text-only entries (`@alia.onl/sdk/text`, `@alia.onl/sdk/ask/text`) never reach the voice
 * call — not even behind a lazy import: its socket, protocol and audio engine are not in a
 * text-only app's bundle. `AliaChatContent` draws the call through `VoiceCallContext`, which only
 * `withVoiceCall` fills. Their voice counterparts (the root, `@alia.onl/sdk/ask`) do reach it.
 */
const CALL_MODULES = [
  path.join(SRC, 'components', 'voice', 'withVoiceCall.tsx'),
  path.join(SRC, 'components', 'voice', 'AliaVoiceCall.tsx'),
  path.join(SRC, 'components', 'voice', 'AliaVoiceCall.web.tsx'),
  path.join(SRC, 'components', 'voice', 'VoiceSession.tsx'),
  VOICE_LOOP,
];
for (const entry of ['text.ts', 'ask-text.ts']) {
  const text = walk(entry, AUDIO_ENGINE);
  if (text.visited.size < MIN_MODULES_FROM_ROOT) {
    failures.push(
      `Only ${text.visited.size} modules reachable from src/${entry} — the walker is broken or the entry was gutted.`,
    );
  }
  const reached = CALL_MODULES.filter((file) => text.visited.has(file));
  if (reached.length > 0 || text.hits.length > 0) {
    failures.push(
      `src/${entry} is text-only but reaches the voice call. Draw the call through ` +
        'VoiceCallContext, never import it from the chat.\n' +
        [...reached, ...text.hits]
          .map((file) => `    ${chainTo(file, text.importedBy)}`)
          .join('\n'),
    );
  }
}
for (const entry of ['index.ts', 'ask.ts']) {
  const withCall = walk(entry, AUDIO_ENGINE);
  if (!withCall.visited.has(path.join(SRC, 'components', 'voice', 'VoiceSession.tsx'))) {
    failures.push(
      `src/${entry} no longer reaches components/voice/VoiceSession.tsx: its chat lost the voice ` +
        'call, or the walker stopped resolving — and the text-only check proves nothing.',
    );
  }
}

/**
 * Web: no async chunk boundary inside the SDK. The leaf entries and the root draw none; each ask
 * entry draws exactly its one (provider -> sheet), and nothing behind it draws another.
 */
const describeSites = (sites, importedBy) =>
  sites
    .map(({ file, specifier }) => `    import('${specifier}') in ${chainTo(file, importedBy)}`)
    .join('\n');
for (const entry of [
  'index.ts',
  'text.ts',
  'voice.ts',
  'runtime/index.ts',
  'runtime/model.ts',
  'avatar.ts',
  'tools.ts',
  'csp.ts',
  'lib/content-utils.ts',
]) {
  const web = walk(entry, RETIRED_MODULES[0], { platform: 'web' });
  if (web.dynamic.length > 0) {
    failures.push(
      `On web, src/${entry} reaches a lazy import(): an async chunk boundary inside the SDK, so ` +
        "Metro hoists every module it shares with the app's chunk into __common.js (first paint). " +
        'Give the lazy load a `.web` fork that imports statically (see lib/deferred/).\n' +
        describeSites(web.dynamic, web.importedBy),
    );
  }
}
for (const { entry, boundary } of ASK_ENTRIES) {
  const askWeb = walk(entry, RETIRED_MODULES[0], { platform: 'web' });
  const askExtra = askWeb.dynamic.filter(
    ({ file, specifier }) => file !== boundary.file || specifier !== boundary.specifier,
  );
  if (askExtra.length > 0) {
    failures.push(
      `On web, src/${entry} reaches a lazy import() besides its one boundary to the sheet. Behind ` +
        'that boundary everything must import statically, or Metro splits the sheet and hoists ' +
        'what the chunks share into __common.js.\n' +
        describeSites(askExtra, askWeb.importedBy),
    );
  }
  if (askWeb.dynamic.length === askExtra.length) {
    failures.push(
      `On web, src/${entry} no longer loads its sheet lazily, so the chat is in the entry bundle ` +
        'of every app that mounts the ask provider — or the walker stopped resolving.',
    );
  }
}
// Positive control: natively, the root does reach a lazy import() (the call's audio engine), so
// the web walk passes because of the `.web` forks, not because the walker misses `import()`.
if (walk('index.ts', RETIRED_MODULES[0]).dynamic.length === 0) {
  failures.push(
    'src/index.ts reaches no lazy import() on native either: the web check proves nothing (the ' +
      'walker stopped matching import(), or the call is no longer loaded lazily on native).',
  );
}

if (failures.length > 0) {
  console.error('Entry isolation check FAILED:\n');
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log(
  `Entry check OK — the voice call and ${AUDIO_ENGINE} are reachable from src/index.ts ` +
    `(${root.visited.size} modules walked) and src/voice.ts; ` +
    `${RETIRED_MODULES.join(' and ')} are reachable from neither; src/text.ts and src/ask-text.ts ` +
    "never reach the call; on web the SDK's only async chunk boundaries are the ask entries' sheets.",
);
