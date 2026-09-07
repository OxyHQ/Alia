/**
 * Path and shell-argument handling for container commands.
 *
 * ## Why these live here rather than in `docker.ts`
 *
 * They are the security-relevant part — a path that escapes `/workspace` and a
 * shell argument that escapes its quotes are the two ways a caller turns a file
 * operation into something else — and they are pure functions with no
 * dependencies. In `docker.ts` they were unreachable by any test: that module
 * constructs a Dockerode client at import time and imports `log` from
 * `../index.js`, the server entrypoint, so importing it to test a string
 * function starts the service.
 *
 * Nothing about the behaviour changed in the move.
 */

export const WORKSPACE_ROOT = '/workspace';

/** Docker's short form. Callers hand us either form; the map is keyed on this. */
export function shortId(containerId: string): string {
  return containerId.slice(0, 12);
}

/**
 * Single-quote a value for `sh -c`.
 *
 * `'` closes the quote, so an embedded one is emitted as `'\''`: close, escaped
 * literal quote, reopen. Everything else — `$`, backticks, `;`, newlines — is
 * literal inside single quotes, which is why this is the whole rule.
 */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve a caller-supplied path to an absolute one under `/workspace`.
 *
 * Rejects rather than sanitises: a `..` segment is an error, not something to
 * drop, because a caller that sent one is asking for something this function
 * cannot give and should be told so. A NUL is rejected for the same reason it
 * always is — everything downstream is C, and a NUL truncates.
 */
export function normalizeWorkspacePath(inputPath: string): string {
  let normalized = inputPath.replace(/\\/g, '/').trim();
  if (!normalized || normalized.includes('\0')) {
    throw new Error('Invalid path');
  }

  if (normalized.startsWith('/')) normalized = normalized.slice(1);
  if (normalized.startsWith('workspace/')) {
    normalized = normalized.slice('workspace/'.length);
  } else if (normalized === 'workspace') {
    return WORKSPACE_ROOT;
  }

  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') throw new Error('Path traversal is not allowed');
    segments.push(segment);
  }

  if (segments.length === 0) return WORKSPACE_ROOT;
  return `${WORKSPACE_ROOT}/${segments.join('/')}`;
}
