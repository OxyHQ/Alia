/**
 * Tool Execution Sandbox
 * URL validation and SSRF protection for tools that fetch external URLs.
 */

import { URL } from 'url';
import net from 'net';

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
 * Check if an IP address is in a private/internal range.
 */
function isPrivateIP(ip: string): boolean {
  // IPv4 private ranges
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p))) return false;

  const [a, b] = parts;
  return (
    a === 127 ||                        // 127.0.0.0/8 (loopback)
    a === 10 ||                         // 10.0.0.0/8 (private)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 (private)
    (a === 192 && b === 168) ||          // 192.168.0.0/16 (private)
    (a === 169 && b === 254) ||          // 169.254.0.0/16 (link-local / cloud metadata)
    a === 0                              // 0.0.0.0/8 (current network)
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
export function validateUrl(urlString: string): UrlValidationResult {
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

  return { valid: true };
}
