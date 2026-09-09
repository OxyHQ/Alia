/**
 * URL validation for the tools that fetch a URL Alia did not choose.
 *
 * `webScraper` and `browse` are handed whatever the model produces, which is
 * shaped by search results and by what the person typed. Both requests leave
 * from inside the VPC.
 *
 * This used to be entirely syntactic — a set of internal hostnames plus private
 * addresses written literally into the URL — so it never resolved anything, and
 * `http://a-name-i-control.example/` whose A record answered `169.254.169.254`
 * passed every check and was fetched. The address judgement now lives in
 * `lib/public-host.ts`, which resolves the name and refuses if ANY address it
 * answers with is non-public, and which `favicon.ts` uses for the same reason.
 *
 * The syntactic checks below are kept in front of it: they refuse the obvious
 * cases without spending a lookup, and a null byte or a `file://` scheme is not
 * a question DNS can answer.
 */

import { URL } from 'url';
import net from 'net';
import { classifyHost } from '../public-host.js';

/** Names refused before a lookup is even spent. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google',
  'instance-data',
  '169.254.169.254',
  '0.0.0.0',
  '[::1]',
]);

/**
 * An address literal written straight into the URL. `classifyHost` refuses
 * literals outright, but this answers with a reason a reader understands.
 */
function isPrivateIP(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;

  const [a, b] = parts;
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate a URL for safe fetching. Blocks SSRF vectors:
 * - Private IPs (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x)
 * - Internal hostnames (localhost, metadata.google.internal)
 * - Non-HTTP protocols (file://, ftp://, etc.)
 * - Null bytes (path traversal)
 */
export async function validateUrl(urlString: string): Promise<UrlValidationResult> {
  // Block null bytes
  if (urlString.includes('\0')) {
    return { valid: false, reason: 'Null bytes not allowed in URLs' };
  }

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  // Only allow HTTP/HTTPS
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { valid: false, reason: `Protocol "${url.protocol}" not allowed. Only HTTP/HTTPS.` };
  }

  // Block known internal hostnames
  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { valid: false, reason: 'Internal hostname blocked' };
  }

  // Block raw IP addresses in private ranges
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      return { valid: false, reason: 'Private IP addresses are blocked' };
    }
  }

  // Block IPv6 loopback and private
  if (hostname.startsWith('[') || hostname === '::1') {
    return { valid: false, reason: 'IPv6 loopback addresses are blocked' };
  }

  // The real guard: resolve, and refuse if any address the name answers with
  // is one this service must not reach. Everything above is a string test.
  const verdict = await classifyHost(hostname);
  if (verdict === 'refused') {
    return { valid: false, reason: 'Hostname resolves to a non-public address' };
  }
  if (verdict === 'unresolvable') {
    return { valid: false, reason: 'Hostname does not resolve' };
  }

  return { valid: true };
}
