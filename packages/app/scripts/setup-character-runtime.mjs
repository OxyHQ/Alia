/**
 * Serves Bloom's 3D character runtime (`AgentAvatar`) from `public/bloom-character/`.
 *
 * The runtime is ~11 MB of engine, WASM and data that Bloom ships beside its code and
 * expects the host to serve unchanged, so it is copied from the installed package on
 * every dev, web and build run rather than committed: a committed copy would drift from
 * the installed Bloom (same reasoning as `setup-skia-web`).
 *
 *     bun scripts/setup-character-runtime.mjs
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bloomRoot = dirname(createRequire(import.meta.url).resolve('@oxy.so/bloom/package.json'));
const source = join(bloomRoot, 'assets', 'character-runtime');
const target = join(APP_ROOT, 'public', 'bloom-character');

if (!existsSync(join(source, 'runtime.mjs'))) {
  console.error(`@oxy.so/bloom ships no character runtime at ${source}`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`character runtime -> ${target}`);
