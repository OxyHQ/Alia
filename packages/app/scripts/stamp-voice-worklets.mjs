/**
 * Publishes the SDK's voice worklets (`@alia.onl/sdk/worklets/voice-processors.js`) under their
 * content hash in `public/sdk/voice-worklets/`, where every app that embeds the SDK loads them
 * from (`alia.onl/sdk/voice-worklets/<revision>.js`, `packages/alia-chat/src/lib/voice-worklets.ts`).
 *
 * Committed and append-only, unlike the character runtime: an app ships the SDK on its own
 * release cycle, so the revision its SDK names must keep being served after the worklets change
 * here. This adds the current revision and never removes one; `voice-worklets-served.test.ts`
 * fails until it has run.
 *
 *     bun run stamp:voice-worklets
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = dirname(createRequire(import.meta.url).resolve('@alia.onl/sdk/package.json'));
const bytes = readFileSync(join(sdkRoot, 'worklets', 'voice-processors.js'));
const revision = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const target = join(APP_ROOT, 'public', 'sdk', 'voice-worklets', `${revision}.js`);

if (existsSync(target)) {
  console.log(`voice worklets ${revision} already published`);
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  console.log(`voice worklets ${revision} -> ${target}`);
}
