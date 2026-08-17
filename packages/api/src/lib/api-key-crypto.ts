/**
 * Recognising and digesting a developer API key.
 *
 * These were `DeveloperApiKeySchema.statics.generateKey` and `.hashKey` — pure
 * cryptography that never touched the collection and only lived on the model
 * because that is where Mongoose puts statics. With the model gone they are
 * ordinary functions, and having exactly one place that computes the digest is
 * what keeps the stored credentials and the authentication path in agreement.
 *
 * ## `generateDeveloperApiKey` is gone
 *
 * ADR 0001 gives developer credentials to Oxy and #139 workstream 11 closes
 * issuance here, so nothing mints an `alia_sk_*` any more and the generator has
 * been deleted rather than left for a caller to find. It is the cheapest form
 * the guarantee can take: reintroducing issuance now means writing the
 * cryptography again in the open, under review, rather than adding one import to
 * a route.
 *
 * What remains is what AUTHENTICATION needs — the prefix the middleware screens
 * on and the digest it looks a presented key up by. Both stay for the whole
 * compatibility window; every credential Alia already issued keeps working.
 *
 * `validateKey`, the third member of the original trio, was never ported: it was
 * an instance method comparing a candidate against `this.keyHash`, and it had no
 * caller anywhere in the repository — measured. Authentication hashes the
 * presented key and LOOKS IT UP by digest, which is the same test done by the
 * index instead of in JavaScript, so re-implementing it would add a second way
 * to answer one question.
 */

import crypto from 'crypto';

/** The prefix every Alia developer key carries, and what the middleware screens on. */
export const API_KEY_PREFIX = 'alia_sk_';

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
