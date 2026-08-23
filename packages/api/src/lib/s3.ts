import { S3Client, DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import { log } from './logger.js';

/**
 * The credential pair the environment carries, or `undefined` to let the SDK
 * resolve one itself.
 *
 * The distinction is the whole point, and `|| ''` got it backwards: an explicit
 * `{ accessKeyId: '', secretAccessKey: '' }` is still an EXPLICIT credential, so
 * the SDK signs with nothing and every call fails instead of falling through to
 * its provider chain. Omitting the key entirely is what reaches the chain, and
 * the chain is what resolves the ECS task role.
 *
 * That matters because the task definition injects a static IAM user's keys
 * today while ALSO declaring a task role that is a strict superset of that
 * user's permissions — the user's keys shadow the role, so the role is unused.
 * When the injection is removed this is what lets the role take over, and an
 * S3-compatible endpoint (DigitalOcean Spaces) is unaffected either way,
 * because its credentials are exactly what the environment carries.
 */
export function resolveS3Credentials(
  env: NodeJS.ProcessEnv = process.env,
): { accessKeyId: string; secretAccessKey: string } | undefined {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return undefined;
  return { accessKeyId, secretAccessKey };
}

const explicitCredentials = resolveS3Credentials();

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT_URL, // Support for DigitalOcean Spaces and other S3-compatible services
  ...(explicitCredentials ? { credentials: explicitCredentials } : {}),
  forcePathStyle: false, // Required for DigitalOcean Spaces
});

const BUCKET_NAME = process.env.AWS_S3_BUCKET || '';

/** Compute base URL once at module load (used for S3 API operations like delete) */
const S3_BASE_URL = (() => {
  if (process.env.AWS_ENDPOINT_URL) {
    const host = new URL(process.env.AWS_ENDPOINT_URL).host;
    return `https://${BUCKET_NAME}.${host}`;
  }
  return `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com`;
})();

/** Public-facing URL for uploaded files (prefer CDN if configured, else same as S3_BASE_URL) */
const S3_PUBLIC_URL = process.env.AWS_CDN_URL
  ? process.env.AWS_CDN_URL.replace(/\/$/, '')
  : S3_BASE_URL;

/** Upload a buffer to S3 with the given key and content type. Returns the public URL. */
async function executeUpload(key: string, file: Buffer, contentType: string): Promise<string> {
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: file,
    ContentType: contentType,
  }));

  return `${S3_PUBLIC_URL}/${key}`;
}

/**
 * Upload a file to S3 with a unique (UUID-based) key.
 *
 * Key format: {NODE_ENV}/{folder}/{descriptor}-{uuid}.{ext}
 * Example:    production/organizations/6831abc/logo-a1b2c3d4.png
 */
export async function uploadToS3(
  file: Buffer,
  filename: string,
  folder: string = 'uploads',
  descriptor: string = 'file'
): Promise<string> {
  const env = process.env.NODE_ENV || 'development';
  const ext = filename.split('.').pop() || '';
  const key = `${env}/${folder}/${descriptor}-${crypto.randomUUID()}.${ext}`;

  return executeUpload(key, file, getContentType(ext));
}

/**
 * Upload a file to S3 with a deterministic (fixed) key.
 * Overwrites on re-upload — ideal for seeded/static assets.
 */
export async function uploadToS3Deterministic(
  file: Buffer,
  key: string,
  contentType: string,
): Promise<string> {
  return executeUpload(key, file, contentType);
}

/**
 * Delete a file from S3
 * @param fileUrl - Full S3 URL
 */
export async function deleteFromS3(fileUrl: string): Promise<void> {
  try {
    // Extract key from URL
    const url = new URL(fileUrl);
    const key = url.pathname.substring(1); // Remove leading slash

    const command = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    await s3Client.send(command);
  } catch (error) {
    log.general.error({ err: error }, 'Error deleting from S3');
    // Don't throw, just log - file might already be deleted
  }
}

/**
 * Get content type based on file extension
 */
function getContentType(extension: string): string {
  const contentTypes: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    txt: 'text/plain',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    opus: 'audio/opus',
    aac: 'audio/aac',
    flac: 'audio/flac',
  };

  // The extension comes off an uploaded FILENAME, so it is the caller's string.
  // `contentTypes['constructor']` is a function, truthy, so `||` never fired and
  // the S3 object was written with `function Object() { [native code] }` as its
  // Content-Type.
  const normalized = extension.toLowerCase();
  return Object.hasOwn(contentTypes, normalized) ? contentTypes[normalized] : 'application/octet-stream';
}
