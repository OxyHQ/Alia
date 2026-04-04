import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We need to control the env var before importing crypto-utils,
// so we use dynamic imports and reset modules between tests.

describe('crypto-utils', () => {
  const VALID_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  describe('with encryption key set', () => {
    it('encrypts and decrypts a string roundtrip', async () => {
      process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY;
      const { encrypt, decrypt } = await import('../crypto-utils.js');

      const plaintext = 'my-oauth-access-token-12345';
      const encrypted = encrypt(plaintext);

      expect(encrypted).not.toBe(plaintext);
      expect(encrypted.split(':')).toHaveLength(3);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it('produces different ciphertext each time (random IV)', async () => {
      process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY;
      const { encrypt } = await import('../crypto-utils.js');

      const plaintext = 'same-token';
      const a = encrypt(plaintext);
      const b = encrypt(plaintext);

      expect(a).not.toBe(b);
    });

    it('handles empty string', async () => {
      process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY;
      const { encrypt, decrypt } = await import('../crypto-utils.js');

      const encrypted = encrypt('');
      expect(decrypt(encrypted)).toBe('');
    });

    it('handles unicode content', async () => {
      process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY;
      const { encrypt, decrypt } = await import('../crypto-utils.js');

      const plaintext = 'token-with-émojis-🔑-and-日本語';
      expect(decrypt(encrypt(plaintext))).toBe(plaintext);
    });

    it('handles long tokens', async () => {
      process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY;
      const { encrypt, decrypt } = await import('../crypto-utils.js');

      const plaintext = 'x'.repeat(10000);
      expect(decrypt(encrypt(plaintext))).toBe(plaintext);
    });
  });

  describe('without encryption key', () => {
    it('throws on encrypt when key is missing', async () => {
      delete process.env.TOKEN_ENCRYPTION_KEY;
      const { encrypt } = await import('../crypto-utils.js');

      expect(() => encrypt('test')).toThrow('TOKEN_ENCRYPTION_KEY is required');
    });

    it('throws on decrypt when key is missing', async () => {
      delete process.env.TOKEN_ENCRYPTION_KEY;
      const { decrypt } = await import('../crypto-utils.js');

      expect(() => decrypt('aa:bb:cc')).toThrow('TOKEN_ENCRYPTION_KEY is required');
    });
  });

  describe('tampered ciphertext', () => {
    it('throws on tampered auth tag', async () => {
      process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY;
      const { encrypt, decrypt } = await import('../crypto-utils.js');

      const encrypted = encrypt('secret');
      const parts = encrypted.split(':');
      parts[1] = 'ff'.repeat(16);
      const tampered = parts.join(':');

      expect(() => decrypt(tampered)).toThrow();
    });

    it('throws on invalid format', async () => {
      process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY;
      const { decrypt } = await import('../crypto-utils.js');

      expect(() => decrypt('not-encrypted')).toThrow('Invalid encrypted value format');
    });
  });

  describe('invalid key format', () => {
    it('throws on non-hex key', async () => {
      process.env.TOKEN_ENCRYPTION_KEY = 'not-a-valid-hex-key-at-all!!!!!!';
      await expect(import('../crypto-utils.js').then(m => m.encrypt('test'))).rejects.toThrow();
    });

    it('throws on wrong-length hex key', async () => {
      process.env.TOKEN_ENCRYPTION_KEY = 'aabb'; // too short
      await expect(import('../crypto-utils.js').then(m => m.encrypt('test'))).rejects.toThrow();
    });
  });
});
