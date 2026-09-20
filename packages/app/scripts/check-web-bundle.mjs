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
 * `components/ui/skill-cover-canvas.web.tsx` deliberately draws without it, and
 * `components/__tests__/skill-cover-static.test.tsx` holds that line. So
 * `canvaskit.wasm` — 8,076,553 B, which `bun run setup-skia-web` copies into
 * `public/` — was being deployed and never fetched, and the web build scripts
 * no longer copy it.
 *
 * That trade needs a loud failure, not a silent 404: the moment a web path can
 * reach Skia, the wasm has to come back. This check is that alarm.
 */
import { readFileSync, readdirSync } from 'node:fs';
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
      'web path off Skia: see components/ui/skill-cover-canvas.web.tsx.',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(`check-web-bundle: ${chunks.length} chunks, no Skia — canvaskit.wasm is correctly absent.`);
