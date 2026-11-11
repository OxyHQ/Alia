/**
 * How big a tool argument, tool result or reasoning chunk was, which is all a
 * log may say about it.
 *
 * This replaced a 500-character PREVIEW of the same value (epic #139 workstream
 * 15). A tool's arguments are model output and its result is usually user data
 * the tool went and fetched, so the preview was message content in an ordinary
 * request log — reachable in production behind one `LOG_LEVEL=debug`, and on by
 * default in development. The size is what the line was actually read for:
 * telling an empty payload from a truncated one from a huge one.
 *
 * The two REASONING lines are the same shape and were missed then (#139 ws19):
 * they logged 100 characters of the model's chain of thought under the key
 * `reasoning`, which the census's key list did not name, so nothing went red.
 *
 * `-1` for a value that cannot be measured, so a circular structure reports a
 * fact rather than throwing inside a log call.
 */
export function sizeForLog(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length ?? -1;
  } catch {
    return -1;
  }
}
