import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import crypto from 'crypto';
import { log } from './logger.js';

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT_URL, // Support for DigitalOcean Spaces and other S3-compatible services
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: false, // Required for DigitalOcean Spaces
});

const BUCKET_NAME = process.env.AWS_S3_BUCKET || '';

/** Compute base URL once at module load */
const S3_BASE_URL = (() => {
  if (process.env.AWS_ENDPOINT_URL) {
    const host = new URL(process.env.AWS_ENDPOINT_URL).host;
    return `https://${BUCKET_NAME}.${host}`;
  }
  return `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com`;
})();

/** Upload a buffer to S3 with the given key and content type. Returns the public URL. */
async function executeUpload(key: string, file: Buffer, contentType: string): Promise<string> {
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: file,
      ContentType: contentType,
      ACL: 'public-read',
    },
  });

  await upload.done();

  return `${S3_BASE_URL}/${key}`;
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
  };

  return contentTypes[extension.toLowerCase()] || 'application/octet-stream';
}
