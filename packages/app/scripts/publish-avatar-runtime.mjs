import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { avatarReleasePath } from '../worker/avatar-releases.js';

export const RUNTIME_BUCKET = 'alia-avatar-runtime';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Validate the whole release before making any writes. The manifest's exact bytes own its URL. */
export async function readAvatarRelease(directory, expectedRevision) {
  const manifestBytes = await readFile(join(directory, 'manifest.json'));
  const revision = hash(manifestBytes);
  if (expectedRevision && revision !== expectedRevision)
    throw new Error('Runtime revision does not match the native package');
  const manifest = JSON.parse(manifestBytes);
  if (
    manifest.version !== 1 ||
    manifest.entry !== 'runtime.mjs' ||
    !manifest.files?.['runtime.mjs']
  )
    throw new Error('Invalid runtime manifest');
  const files = [];
  for (const [name, expected] of Object.entries(manifest.files)) {
    const path = avatarReleasePath(`/bloom-character/releases/${revision}/${name}`);
    if (!path || name === 'manifest.json' || !/^[a-f0-9]{64}$/.test(expected))
      throw new Error(`Invalid manifest path/hash: ${name}`);
    const bytes = await readFile(join(directory, name));
    if (hash(bytes) !== expected) throw new Error(`Runtime integrity mismatch: ${name}`);
    const file = {
      key: path.key,
      name,
      type: path.type,
      filePath: join(directory, name),
      size: bytes.length,
      sha256: expected,
    };
    files.push(file);
    if (name.endsWith('.bin')) {
      files.push({ ...file, key: `${path.key}.gz`, encoding: 'gzip' });
      files.push({ ...file, key: `flat/${name}.gz`, encoding: 'gzip' });
    }
  }
  // The manifest is the last object, so its existence records a completed release.
  files.push({
    key: `releases/${revision}/manifest.json`,
    name: 'manifest.json',
    type: 'application/json',
    bytes: manifestBytes,
    size: manifestBytes.length,
    sha256: revision,
  });
  return { revision, files };
}
/** Only conditional creates; existing bytes must match. No delete/overwrite API exists here. */
export async function publishAvatarRelease(release, store) {
  let uploaded = 0,
    reused = 0,
    gzipBytes = 0;
  const matches = (file, bytes) => {
    try {
      return hash(file.encoding ? gunzipSync(bytes) : bytes) === file.sha256;
    } catch {
      return false;
    }
  };
  const publish = async (file) => {
    const existing = await store.get(file.key);
    if (existing !== null) {
      if (!matches(file, existing))
        throw new Error(`Refusing to overwrite immutable runtime object: ${file.key}`);
      reused++;
      if (file.encoding) gzipBytes += existing.length;
      return;
    }
    const source = file.bytes ?? (await readFile(file.filePath));
    if (hash(source) !== file.sha256)
      throw new Error(`Runtime changed after validation: ${file.name}`);
    const bytes = file.encoding ? gzipSync(source, { level: 6 }) : source;
    await store.create(file.key, bytes, file.type, file.encoding);
    const verified = await store.get(file.key);
    if (verified === null || !matches(file, verified))
      throw new Error(`Uploaded runtime verification failed: ${file.key}`);
    uploaded++;
    if (file.encoding) gzipBytes += verified.length;
  };
  // Bound RAM/network concurrency; the manifest never commits a failed partial batch.
  let cursor = 0,
    failure;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (!failure && cursor < release.files.length - 1) {
        const file = release.files[cursor++];
        try {
          await publish(file);
        } catch (error) {
          failure = error;
        }
      }
    }),
  );
  if (failure) throw failure;
  await publish(release.files.at(-1));
  return {
    revision: release.revision,
    uploaded,
    reused,
    sourceBytes: release.files.filter((f) => !f.encoding).reduce((n, f) => n + f.size, 0),
    gzipSidecarBytes: gzipBytes,
  };
}
export function s3RuntimeStore(client) {
  return {
    async get(key) {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: RUNTIME_BUCKET, Key: key }),
        );
        return Buffer.from(await response.Body.transformToByteArray());
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async create(key, bytes, type, encoding) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: RUNTIME_BUCKET,
            Key: key,
            Body: bytes,
            ContentType: type,
            ContentEncoding: encoding,
            CacheControl: 'public, max-age=31536000, immutable',
            IfNoneMatch: '*',
          }),
        );
      } catch (error) {
        // A concurrent publisher may have created the object; caller verifies its bytes.
        if (error.$metadata?.httpStatusCode !== 412) throw error;
      }
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const require = createRequire(import.meta.url);
  const directory =
    process.argv.slice(2).find((arg) => !arg.startsWith('--')) ||
    join(dirname(require.resolve('@oxy.so/bloom/package.json')), 'assets', 'character-runtime');
  const expected =
    process.env.AVATAR_RUNTIME_REVISION ??
    require('@oxy.so/bloom-avatar-native/runtime-revision').AVATAR_RUNTIME_REVISION;
  const release = await readAvatarRelease(directory, expected);
  if (process.argv.includes('--check')) {
    console.log(
      JSON.stringify({
        revision: release.revision,
        files: release.files.filter((f) => !f.encoding).length,
        gzipSidecars: release.files.filter((f) => f.encoding).length,
        bytes: release.files.filter((f) => !f.encoding).reduce((n, f) => n + f.size, 0),
      }),
    );
  } else {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const accessKeyId = process.env.AVATAR_R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AVATAR_R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKeyId || !secretAccessKey)
      throw new Error('Cloudflare account and scoped avatar R2 credentials are required');
    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    });
    try {
      console.log(JSON.stringify(await publishAvatarRelease(release, s3RuntimeStore(client))));
    } finally {
      client.destroy();
    }
  }
}
