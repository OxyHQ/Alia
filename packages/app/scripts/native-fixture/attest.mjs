import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = resolve(app, '../..');
const apk = resolve(process.env.APK);
const out = resolve(process.env.OUT);
mkdirSync(out, { recursive: true });
const hash = (data) => createHash('sha256').update(data).digest('hex');
const run = (command, args) => execFileSync(command, args, { maxBuffer: 256 * 1024 * 1024 });
const bundle = run('unzip', ['-p', apk, 'assets/index.android.bundle']);
assert(
  bundle.equals(
    readFileSync(
      resolve(app, 'android/app/build/generated/assets/react/alia663Lab/index.android.bundle'),
    ),
  ),
);
const mapPath = resolve(
  app,
  'android/app/build/intermediates/sourcemaps/react/alia663Lab/index.android.bundle.packager.map',
);
const records = {};
function collect(map) {
  if (map.sections) return map.sections.forEach((section) => collect(section.map));
  for (let i = 0; i < map.sources.length; i++) {
    const name = map.sources[i];
    if (!/\.[cm]?[jt]sx?$/.test(name)) continue;
    if (!name.startsWith('/packages/alia-chat/') && !name.startsWith('/packages/app/')) continue;
    const content = map.sourcesContent[i];
    assert.equal(
      content,
      readFileSync(resolve(root, `.${name}`), 'utf8'),
      `Embedded source differs: ${name}`,
    );
    records[name] = hash(content);
  }
}
collect(JSON.parse(readFileSync(mapPath, 'utf8')));
for (const required of [
  '/packages/alia-chat/src/components/AliaComposer.tsx',
  '/packages/app/bloom-local/node_modules/@oxy.so/bloom/src/composer-loader/AndroidLight.tsx',
  '/packages/app/bloom-local/node_modules/@oxy.so/bloom/src/composer-panel/ComposerControls.tsx',
  '/packages/app/app/_layout.tsx',
  '/packages/app/app/(app)/_layout.tsx',
  '/packages/app/fixtures/entry.native.tsx',
  '/packages/app/fixtures/routes/(app)/__fixtures/[id].tsx',
])
  assert(records[required], `Missing actual component: ${required}`);
const analyzer = resolve(process.env.ANDROID_HOME, 'cmdline-tools/latest/bin/apkanalyzer');
const manifest = run(analyzer, ['manifest', 'print', apk]).toString();
writeFileSync(resolve(out, 'AndroidManifest.xml'), manifest);
assert(manifest.includes('package="onl.alia.composer663"'));
assert(!/android:debuggable="true"/.test(manifest));
for (const name of [
  'INTERNET',
  'ACCESS_NETWORK_STATE',
  'ACCESS_WIFI_STATE',
  'RECORD_AUDIO',
  'CAMERA',
  'POST_NOTIFICATIONS',
  'READ_EXTERNAL_STORAGE',
  'WRITE_EXTERNAL_STORAGE',
  'SYSTEM_ALERT_WINDOW',
]) {
  assert(
    !new RegExp(`<uses-permission[^>]*android:name="android.permission.${name}"`).test(manifest),
    `Permission remains: ${name}`,
  );
}
assert(
  /<meta-data[^>]*android:name="expo.modules.updates.ENABLED"[^>]*android:value="false"/s.test(
    manifest,
  ),
);
for (const name of ['so.oxy.permission.IDENTITY', 'so.oxy.permission.DEVICE_SESSION']) {
  assert(!manifest.includes(`android:name="${name}"`), `Identity permission remains: ${name}`);
}
const report = {
  apkSha256: hash(readFileSync(apk)),
  bundleSha256: hash(bundle),
  mapSha256: hash(readFileSync(mapPath)),
  manifestSha256: hash(manifest),
  sourceCommit: run('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(),
  bloomPackageSha256: readFileSync(resolve(app, 'bloom-local/.built-sha256'), 'utf8').trim(),
  lockSha256: hash(readFileSync(resolve(root, 'bun.lock'))),
  embeddedSources: records,
  scope:
    'Real Alia layouts and SDK with synthetic offline turn. Built Bloom mirror is not published-package adoption. RN DEX and physical acceptance are separate gates.',
};
writeFileSync(resolve(out, 'attestation.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({ apkSha256: report.apkSha256, sources: Object.keys(records).length, out }),
);
