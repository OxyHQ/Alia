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

/**
 * Upload a file to S3
 * @param file - File buffer
 * @param filename - Original filename
 * @param folder - Entity path in S3 (e.g., 'organizations/{id}')
 * @param descriptor - File purpose label (e.g., 'logo', 'avatar', 'icon')
 * @returns S3 file URL
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
  const fileExtension = filename.split('.').pop();
  const uniqueFilename = `${env}/${folder}/${descriptor}-${crypto.randomUUID()}.${fileExtension}`;

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: BUCKET_NAME,
      Key: uniqueFilename,
      Body: file,
      ContentType: getContentType(fileExtension || ''),
      ACL: 'public-read', // Make file publicly accessible
    },
  });

  await upload.done();

  // Return the public URL
  // For DigitalOcean Spaces or custom endpoints, construct URL differently
  if (process.env.AWS_ENDPOINT_URL) {
    const endpoint = process.env.AWS_ENDPOINT_URL.replace('https://', '');
    return `https://${BUCKET_NAME}.${endpoint}/${uniqueFilename}`;
  }

  // For standard AWS S3
  return `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${uniqueFilename}`;
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
  };

  return contentTypes[extension.toLowerCase()] || 'application/octet-stream';
}
