/**
 * Minting and digesting a developer API key.
 *
 * These were `DeveloperApiKeySchema.statics.generateKey` and `.hashKey` — pure
 * cryptography that never touched the collection and only lived on the model
 * because that is where Mongoose puts statics. With the model gone they are
 * ordinary functions, and having exactly one place that computes the digest is
 * what keeps the minting path and the authentication path in agreement.
 *
 * `validateKey`, the third member of that trio, is NOT ported: it was an
 * instance method comparing a candidate against `this.keyHash`, and it had no
 * caller anywhere in the repository — measured. Authentication hashes the
 * presented key and LOOKS IT UP by digest, which is the same test done by the
 * index instead of in JavaScript, so re-implementing it would add a second way
 * to answer one question.
 */

import crypto from 'crypto';

/** The prefix every Alia developer key carries, and what the middleware screens on. */
export const API_KEY_PREFIX = 'alia_sk_';

/** A fresh key. 32 random bytes, URL-safe base64, prefixed. */
export function generateDeveloperApiKey(): string {
  return `${API_KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

/**
 * The stored digest of a key.
 *
 * Deterministic on purpose: it is a LOOKUP KEY, so it must produce the same
 * value every time. Encrypting it with a randomized IV would make the
 * authentication query match nothing, and the symptom would be a silent 401 on
 * every request rather than an error anyone could trace.
 */
export function hashDeveloperApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}
