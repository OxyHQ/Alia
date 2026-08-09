/**
 * Columns that must never leave the process in a response.
 *
 * Mongoose's `select: false` does not survive the port — `db.select().from(t)`
 * returns EVERY column, so the first naive rewrite of a query is the first time
 * a Telegram session string or a Baileys credential can be serialized into an
 * HTTP response nobody audited.
 *
 * Read through `publicColumns(table, PROTECTED_COLUMNS)` from `@oxyhq/db/assert`.
 * The exclusion is at the TYPE level: the row type has no such property, so a
 * serializer touching one fails `tsc` rather than shipping it — **provided this
 * stays `as const` and is never re-annotated with the registry type**, which
 * would widen the literals away and silently delete the compile-time half.
 *
 * Opting in is explicit and greppable: a path that legitimately needs one names
 * it. There is deliberately no helper for that — it must read differently from
 * an ordinary select.
 */
export const PROTECTED_COLUMNS = {
  /**
   * Baileys credentials and key material. Possession is the WhatsApp account.
   * `lastQr` is short-lived but is a live pairing credential while valid.
   */
  whatsapp_sessions: ['authState', 'authKeys', 'lastQr'],
  /**
   * `sessionString` is a GramJS `StringSession` — a full account credential that
   * needs no second factor to reuse.
   */
  telegram_sessions: ['sessionString', 'lastQr'],
  /**
   * `dataDir` is not a secret, but it names the path holding signal-cli's key
   * material and is host-local; nothing outside this process has any use for it.
   */
  signal_sessions: ['dataDir', 'lastQr'],
  /**
   * Ciphertext, not plaintext — but ciphertext is a token to anyone who also has
   * `TOKEN_ENCRYPTION_KEY`, and the two travel together in an incident.
   */
  mcp_connector_auths: ['clientInformation', 'tokens', 'codeVerifier'],
} as const;
