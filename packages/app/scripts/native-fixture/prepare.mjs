import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only generated Android files change. Run Expo prebuild again to restore them.
const app = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gradleFile = resolve(app, 'android/app/build.gradle');
let gradle = readFileSync(gradleFile, 'utf8');
if (!/applicationId ['"]onl\.alia\.app\.dev['"]/.test(gradle)) {
  throw new Error('Run APP_VARIANT=development expo prebuild first; refusing another application.');
}
if (gradle.includes('alia663Lab'))
  throw new Error('Fixture already prepared; regenerate before repeating.');
gradle = gradle.replace(
  /applicationId ['"]onl\.alia\.app\.dev['"]/,
  'applicationId "onl.alia.composer663"',
);
gradle += `
// Isolated offline acceptance variant; production signing remains unchanged.
android.buildTypes.create('alia663Lab') {
    initWith android.buildTypes.release
    debuggable false
    signingConfig android.signingConfigs.debug
    minifyEnabled false
    shrinkResources false
    matchingFallbacks = ['release']
}
`;
writeFileSync(gradleFile, gradle);
const manifestFile = resolve(app, 'android/app/src/main/AndroidManifest.xml');
let manifest = readFileSync(manifestFile, 'utf8');
const denied = [
  'INTERNET',
  'ACCESS_NETWORK_STATE',
  'ACCESS_WIFI_STATE',
  'RECORD_AUDIO',
  'CAMERA',
  'POST_NOTIFICATIONS',
  'READ_EXTERNAL_STORAGE',
  'WRITE_EXTERNAL_STORAGE',
  'SYSTEM_ALERT_WINDOW',
  'so.oxy.permission.IDENTITY',
  'so.oxy.permission.DEVICE_SESSION',
];
for (const permission of denied) {
  const full = permission.startsWith('so.oxy.') ? permission : `android.permission.${permission}`;
  manifest = manifest.replace(
    new RegExp(`<uses-permission[^>]*android:name="${full.replaceAll('.', '\\.')}"[^>]*/>`, 'g'),
    '',
  );
  manifest = manifest.replace(
    '<application ',
    `<uses-permission android:name="${full}" tools:node="remove"/>\n  <application `,
  );
}
for (const permission of ['so.oxy.permission.IDENTITY', 'so.oxy.permission.DEVICE_SESSION']) {
  manifest = manifest.replace(
    new RegExp(`<permission[^>]*android:name="${permission.replaceAll('.', '\\.')}"[^>]*/>`, 'g'),
    '',
  );
  manifest = manifest.replace(
    '<application ',
    `<permission android:name="${permission}" tools:node="remove"/>\n  <application `,
  );
}
manifest = manifest.replace(
  /android:name="expo.modules.updates.ENABLED" android:value="true"/,
  'android:name="expo.modules.updates.ENABLED" android:value="false"',
);
manifest = manifest.replace(/android:scheme="[^"]+"/g, 'android:scheme="alia663"');
writeFileSync(manifestFile, manifest);
console.log(
  'Prepared isolated onl.alia.composer663 / alia663Lab, no network/micro/camera permissions or OTA.',
);
