/**
 * HTTP Signatures for ActivityPub
 * Implements signing and verification according to the HTTP Signatures spec
 * https://datatracker.ietf.org/doc/html/draft-cavage-http-signatures
 */

import crypto from 'crypto';
import { ActivityPubKey } from '../../models/activitypub-key.js';
import { getKeyId, ACTOR_DOMAIN } from './config.js';

/**
 * Get our private key from database
 */
export async function getPrivateKey(): Promise<string> {
  const keyDoc = await ActivityPubKey.findOne({ actor: 'alia' });
  if (!keyDoc) {
    throw new Error('ActivityPub keys not found. Run generate-keys script first.');
  }
  return keyDoc.privateKey;
}

/**
 * Get our public key from database
 */
export async function getPublicKey(): Promise<string> {
  const keyDoc = await ActivityPubKey.findOne({ actor: 'alia' });
  if (!keyDoc) {
    throw new Error('ActivityPub keys not found. Run generate-keys script first.');
  }
  return keyDoc.publicKey;
}

/**
 * Create HTTP Signature for outgoing requests
 *
 * @param url - Target URL
 * @param method - HTTP method (POST, GET, etc.)
 * @param body - Request body (for POST requests)
 * @returns Headers object with Signature, Date, and Digest
 */
export async function signRequest(
  url: string,
  method: string,
  body?: any
): Promise<Record<string, string>> {
  const privateKey = await getPrivateKey();
  const urlObj = new URL(url);
  const path = urlObj.pathname + urlObj.search;

  // Create date header (required)
  const date = new Date().toUTCString();

  // Create digest header for POST/PUT requests
  let digest: string | undefined;
  if (body && (method === 'POST' || method === 'PUT')) {
    const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
    const hash = crypto.createHash('sha256').update(bodyString).digest('base64');
    digest = `SHA-256=${hash}`;
  }

  // Build string to sign
  const headers = digest
    ? ['(request-target)', 'host', 'date', 'digest']
    : ['(request-target)', 'host', 'date'];

  const signString = headers
    .map(header => {
      if (header === '(request-target)') {
        return `(request-target): ${method.toLowerCase()} ${path}`;
      }
      if (header === 'host') {
        return `host: ${urlObj.host}`;
      }
      if (header === 'date') {
        return `date: ${date}`;
      }
      if (header === 'digest' && digest) {
        return `digest: ${digest}`;
      }
      return '';
    })
    .join('\n');

  // Sign the string
  const signer = crypto.createSign('sha256');
  signer.update(signString);
  signer.end();
  const signature = signer.sign(privateKey, 'base64');

  // Build signature header
  const keyId = getKeyId();
  const signatureHeader = [
    `keyId="${keyId}"`,
    'algorithm="rsa-sha256"',
    `headers="${headers.join(' ')}"`,
    `signature="${signature}"`
  ].join(',');

  // Return headers
  const result: Record<string, string> = {
    'Date': date,
    'Signature': signatureHeader,
  };

  if (digest) {
    result['Digest'] = digest;
  }

  return result;
}

/**
 * Verify HTTP Signature from incoming requests
 *
 * @param req - Express request object
 * @param publicKey - Public key of the sender (fetched from their actor)
 * @returns true if signature is valid
 */
export function verifySignature(
  req: any,
  publicKey: string
): boolean {
  try {
    const signatureHeader = req.headers['signature'];
    if (!signatureHeader) {
      console.error('[ActivityPub] No signature header found');
      return false;
    }

    // Parse signature header
    const signatureParts = parseSignatureHeader(signatureHeader);
    if (!signatureParts) {
      console.error('[ActivityPub] Failed to parse signature header');
      return false;
    }

    const { headers, signature } = signatureParts;

    // Build string to verify
    const signString = headers
      .map(header => {
        if (header === '(request-target)') {
          return `(request-target): ${req.method.toLowerCase()} ${req.path}`;
        }
        if (header === 'host') {
          return `host: ${req.headers['host'] || ACTOR_DOMAIN}`;
        }
        const value = req.headers[header];
        if (!value) {
          console.error(`[ActivityPub] Missing header: ${header}`);
          return null;
        }
        return `${header}: ${value}`;
      })
      .filter(Boolean)
      .join('\n');

    if (!signString) {
      console.error('[ActivityPub] Failed to build sign string');
      return false;
    }

    // Verify signature
    const verifier = crypto.createVerify('sha256');
    verifier.update(signString);
    verifier.end();

    const isValid = verifier.verify(publicKey, signature, 'base64');

    if (!isValid) {
      console.error('[ActivityPub] Signature verification failed');
      console.error('Sign string:', signString);
    }

    return isValid;
  } catch (error) {
    console.error('[ActivityPub] Error verifying signature:', error);
    return false;
  }
}

/**
 * Parse Signature header
 */
function parseSignatureHeader(header: string): { headers: string[]; signature: string } | null {
  try {
    const parts: Record<string, string> = {};

    // Parse key="value" pairs
    const regex = /(\w+)="([^"]+)"/g;
    let match;
    while ((match = regex.exec(header)) !== null) {
      parts[match[1]] = match[2];
    }

    if (!parts.headers || !parts.signature) {
      return null;
    }

    return {
      headers: parts.headers.split(' '),
      signature: parts.signature,
    };
  } catch (error) {
    console.error('[ActivityPub] Error parsing signature header:', error);
    return null;
  }
}

/**
 * Verify digest header (for POST/PUT requests)
 */
export function verifyDigest(req: any, body: any): boolean {
  try {
    const digestHeader = req.headers['digest'];
    if (!digestHeader) {
      // Digest is optional for some servers
      return true;
    }

    const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
    const hash = crypto.createHash('sha256').update(bodyString).digest('base64');
    const expectedDigest = `SHA-256=${hash}`;

    return digestHeader === expectedDigest;
  } catch (error) {
    console.error('[ActivityPub] Error verifying digest:', error);
    return false;
  }
}
