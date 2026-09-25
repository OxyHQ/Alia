/**
 * Post-export assertions about the emitted web bundle.
 *
 * Run after `expo export --platform web`, against `dist/` — the point is to
 * check what Metro actually wrote, not what the source looks like it would
 * produce. An import that "should" be absent is a claim; a grep over the
 * emitted chunks is evidence.
 *
 *     node scripts/check-web-bundle.mjs [dist]
 *
 * ## Skia
 *
 * `@shopify/react-native-skia` contributes zero bytes to the web export:
 * `src/features/skills/ui/skill-cover-canvas.web.tsx` deliberately draws without it, and
 * `src/features/skills/ui/__tests__/skill-cover-static.test.tsx` holds that line. So
 * `canvaskit.wasm` — 8,076,553 B, which `bun run setup-skia-web` copies into
 * `public/` — was being deployed and never fetched, and the web build scripts
 * no longer copy it.
 *
 * That trade needs a loud failure, not a silent 404: the moment a web path can
 * reach Skia, the wasm has to come back. This check is that alarm.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.argv[2] ?? join(HERE, '../dist'));
const jsDir = join(dist, '_expo/static/js/web');

const SKIA_MARKERS = /canvaskit|CanvasKitInit|react-native-skia|LoadSkiaWeb/;

let chunks;
try {
  chunks = readdirSync(jsDir).filter((f) => f.endsWith('.js'));
} catch {
  console.error(`check-web-bundle: no export at ${jsDir} — run \`expo export --platform web\` first.`);
  process.exit(1);
}
if (chunks.length === 0) {
  console.error(`check-web-bundle: ${jsDir} has no chunks.`);
  process.exit(1);
}

const offenders = chunks.filter((f) => SKIA_MARKERS.test(readFileSync(join(jsDir, f), 'utf8')));
if (offenders.length > 0) {
  console.error(
    [
      'check-web-bundle: Skia reached the web bundle.',
      '',
      `  ${offenders.join('\n  ')}`,
      '',
      'The web build stopped shipping public/canvaskit.wasm (8 MB) because nothing',
      'fetched it. If this import is deliberate, put `bun x setup-skia-web public`',
      'back in the `build` and `build:production` scripts in package.json — without',
      'it the runtime will 404 on /canvaskit.wasm. If it is not deliberate, keep the',
      'web path off Skia: see src/features/skills/ui/skill-cover-canvas.web.tsx.',
    ].join('\n'),
  );
  process.exit(1);
}

/**
 * And the 8 MB itself, which is a different question from whether a chunk
 * imports Skia.
 *
 * `setup-skia-web` writes `public/canvaskit.wasm`, and `expo export` copies the
 * whole of `public/` into `dist/`. The file is gitignored, so a fresh checkout
 * and CI never have it — but a machine that ran the old `prebuild` once keeps
 * it forever, and every export from then on ships 8 MB that nothing fetches
 * while this script happily reports "no Skia". The chunk scan above cannot see
 * that, because there is nothing in the chunks to see: the file is deployed
 * because it is sitting in a directory, not because anything referenced it.
 */
const stray = join(dist, 'canvaskit.wasm');
if (existsSync(stray)) {
  console.error(
    [
      `check-web-bundle: canvaskit.wasm is in the export (${statSync(stray).size} bytes) and nothing fetches it.`,
      '',
      'It came from `public/canvaskit.wasm`, which `expo export` copies wholesale.',
      'That file is left over from a `setup-skia-web` run on this machine — it is',
      'gitignored, so CI does not have it. Delete packages/app/public/canvaskit.wasm',
      'and export again. If the web build is meant to use Skia, the chunk scan above',
      'is the check that should be failing, not this one.',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(`check-web-bundle: ${chunks.length} chunks, no Skia, no stray wasm in the export.`);
