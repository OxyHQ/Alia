import {
  S3Client,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
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

/*
 * There is deliberately no public base URL here any more.
 *
 * This module used to compute one and hand it back from every upload, which is
 * how an address that answers 403 to every browser ended up stored in four
 * tables and returned to clients from three surfaces. Nothing in this file
 * knows how to build a link now: an object is identified by its KEY, and the
 * only thing that turns a key into something a client can fetch is
 * `lib/stored-media.ts`.
 */

/**
 * Upload a buffer, and answer with the object's KEY.
 *
 * Not a URL, and that is the point. This bucket blocks public access at the
 * account level, so the address it would return is one that answers 403 to
 * every browser — a value that LOOKS fetchable, gets stored as if it were, and
 * is handed to clients that cannot fetch it. Three separate surfaces shipped
 * that way: a message's audio, a show, and the speech endpoint itself.
 *
 * A key cannot be mistaken for a link. Code that means to give a client an
 * address has to say so, by calling {@link storedMediaUrl}, which is the one
 * place that can produce one.
 */
async function executeUpload(key: string, file: Buffer, contentType: string): Promise<string> {
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: file,
    ContentType: contentType,
  }));

  return key;
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


/** One stored object, for a route that streams it to a player. */
export interface S3ObjectStream {
  readonly body: NodeJS.ReadableStream;
  readonly contentType: string;
  readonly contentLength?: number;
}

/**
 * Read an object back out.
 *
 * The content type is whatever was recorded at upload; a stored object with no
 * recorded type falls back to the extension rather than to
 * `application/octet-stream`, because a media element refuses a type it does
 * not recognise and that refusal is indistinguishable from a broken file.
 */
export async function readS3Object(key: string): Promise<S3ObjectStream | null> {
  if (BUCKET_NAME === '' || key === '') return null;
  try {
    const result = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    if (!result.Body) return null;
    const extension = key.split('.').pop() ?? '';
    return {
      body: result.Body as NodeJS.ReadableStream,
      contentType: result.ContentType ?? getContentType(extension),
      ...(typeof result.ContentLength === 'number' ? { contentLength: result.ContentLength } : {}),
    };
  } catch (error) {
    log.general.warn({ err: error, key }, 'S3 object could not be read');
    return null;
  }
}

/**
 * Delete a stored object, by the key an upload answered with.
 *
 * A key, not a URL. It used to parse one out of a stored address, which only
 * worked while addresses were what got stored — and that is the thing this
 * module stopped doing.
 */
export async function deleteFromS3(key: string): Promise<void> {
  try {
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
 * Every object key under a prefix, following the continuation token.
 *
 * `ListObjectsV2` caps a response at 1000 keys and reports the truncation in a
 * flag most callers never read — a single unpaginated call reports "1000 keys"
 * for a prefix holding a million, and the caller cannot tell that from a prefix
 * that really holds 1000. So the loop is not an optimisation; it is the
 * difference between an answer and a plausible one.
 *
 * An EMPTY prefix is refused. `ListObjectsV2` treats it as "the whole bucket",
 * so a caller that built a prefix from an undefined value would delete
 * everything — and the one caller that deletes is exactly the one most likely to
 * compute its prefix.
 */
export async function listS3ObjectKeys(prefix: string): Promise<string[]> {
  if (BUCKET_NAME === '' || prefix === '') return [];

  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const page = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: prefix,
        ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
      }),
    );

    for (const object of page.Contents ?? []) {
      if (object.Key !== undefined) keys.push(object.Key);
    }

    continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (continuationToken !== undefined);

  return keys;
}

/**
 * Delete every object under a prefix, and report how many went.
 *
 * `DeleteObjects` takes at most 1000 keys per call, so the batching is the same
 * kind of correctness the pagination above is: a single call given 1500 keys
 * fails outright rather than deleting 1000, which is at least loud — but the
 * count it would report is the thing a caller uses to decide the purge worked.
 *
 * The count is what S3 CONFIRMED deleting, not what was asked for. A key that
 * fails to delete is logged and excluded, so a partial purge reports a partial
 * number rather than the number it hoped for.
 */
export async function deleteS3Prefix(prefix: string): Promise<number> {
  const keys = await listS3ObjectKeys(prefix);
  if (keys.length === 0) return 0;

  let deleted = 0;
  for (let start = 0; start < keys.length; start += 1000) {
    const batch = keys.slice(start, start + 1000);
    const result = await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET_NAME,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    );

    // `Quiet: true` reports only the failures, so an empty `Errors` means the
    // whole batch went. Counting the batch minus its errors is what makes the
    // return value a measurement rather than an intention.
    const errors = result.Errors ?? [];
    for (const error of errors) {
      log.general.warn({ key: error.Key, code: error.Code }, 'S3 object could not be deleted');
    }
    deleted += batch.length - errors.length;
  }

  return deleted;
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
