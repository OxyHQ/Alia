import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../..');
const expected = 'c76b6d8f34500ab37fd5dc2e0a08c46a03153ce7';
const source = process.env.ALIA_RN_SOURCE;
if (!source) throw new Error('Set ALIA_RN_SOURCE to the separate reviewed RN source checkout.');
const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
if (git('rev-parse', 'HEAD') !== expected || git('status', '--porcelain')) {
  throw new Error(`React Native source must be clean at ${expected}.`);
}
const requireFromApp = createRequire(resolve(app, 'package.json'));
const installed = requireFromApp('react-native/package.json');
const sourcePackage = JSON.parse(
  readFileSync(resolve(source, 'packages/react-native/package.json')),
);
if (installed.version !== '0.88.1' || sourcePackage.version !== installed.version) {
  throw new Error('Installed JS and source Android React Native must both be 0.88.1.');
}
const android = realpathSync(resolve(app, 'android'));
const args = process.argv.slice(2);
if (!args.length) throw new Error('Pass a Gradle task, for example :app:assembleRelease.');
console.log(
  JSON.stringify({
    source: realpathSync(source),
    commit: expected,
    reactNative: installed.version,
    android,
  }),
);
const result = spawnSync(
  resolve(android, 'gradlew'),
  ['-p', android, '-I', resolve(here, 'source.gradle'), ...args],
  {
    cwd: app,
    env: { ...process.env, ALIA_RN_SOURCE: realpathSync(source), ALIA_ANDROID_DIR: android },
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
