/**
 * The key a batch is de-duplicated by before it becomes one `INSERT`.
 *
 * `ON CONFLICT DO UPDATE` raises `21000` ("cannot affect row a second time")
 * when a single statement would touch one row twice, where Mongo's unordered
 * `bulkWrite` simply applied both operations in turn. Every batch helper in the
 * three gateway repositories therefore collapses its input on the SAME key the
 * unique index is built on, and this is that key.
 *
 * `JSON.stringify` rather than a joined string because both halves are
 * protocol-supplied — a JID, a Telegram chat id, a Signal group id — and no
 * separator character can be assumed absent from either. Two distinct pairs
 * must never produce one key: that would silently drop a row from the batch.
 */
export function conflictKey(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}
