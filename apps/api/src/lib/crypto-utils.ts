import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { log } from './logger.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard
const AUTH_TAG_LENGTH = 16;

let _key: Buffer | null = null;
let _warned = false;

function getKey(): Buffer | null {
  if (_key) return _key;

  const envKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (!envKey) {
    if (!_warned) {
      log.general.warn('TOKEN_ENCRYPTION_KEY not set — OAuth tokens stored in plaintext');
      _warned = true;
    }
    return null;
  }

  // Accept hex-encoded 32-byte key (64 hex chars)
  if (envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
    _key = Buffer.from(envKey, 'hex');
  } else {
    throw new Error('TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }

  return _key;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns format: `iv:authTag:ciphertext` (all hex-encoded).
 * If no encryption key is configured, returns the plaintext as-is.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt a string produced by `encrypt()`.
 * If the value doesn't look encrypted (no colons), returns it as-is (plaintext fallback).
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  if (!key) return ciphertext;

  // Plaintext fallback: if it doesn't match iv:tag:encrypted format, return as-is
  const parts = ciphertext.split(':');
  if (parts.length !== 3) return ciphertext;

  const [ivHex, authTagHex, encryptedHex] = parts;

  // Validate hex format and expected lengths
  if (ivHex.length !== IV_LENGTH * 2 || authTagHex.length !== AUTH_TAG_LENGTH * 2) {
    return ciphertext;
  }

  try {
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    // If decryption fails, the value might be a legacy plaintext token
    // that coincidentally has colons — return as-is
    return ciphertext;
  }
}

/**
 * Check whether a value appears to be encrypted (matches iv:tag:ciphertext format).
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  return parts[0].length === IV_LENGTH * 2 && parts[1].length === AUTH_TAG_LENGTH * 2;
}
