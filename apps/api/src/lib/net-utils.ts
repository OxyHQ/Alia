/**
 * Network Utilities for IP Parsing & Proxy Trust
 *
 * Adapted from OpenClaw's gateway/net.ts for server-side use.
 * Handles X-Forwarded-For, IPv4-mapped IPv6, and loopback detection.
 */

import net from 'node:net';

/**
 * Normalize IPv4-mapped IPv6 addresses to plain IPv4.
 * e.g., "::ffff:192.168.1.1" -> "192.168.1.1"
 */
function normalizeIPv4MappedAddress(ip: string): string {
  if (ip.startsWith('::ffff:')) {
    return ip.slice('::ffff:'.length);
  }
  return ip;
}

function normalizeIp(ip: string | undefined): string | undefined {
  const trimmed = ip?.trim();
  if (!trimmed) return undefined;
  return normalizeIPv4MappedAddress(trimmed.toLowerCase());
}

/**
 * Strip optional port from an IP address string.
 * Handles: "1.2.3.4:8080", "[::1]:8080"
 */
function stripOptionalPort(ip: string): string {
  // Bracketed IPv6: [::1]:8080
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end !== -1) return ip.slice(1, end);
  }
  // Already a valid IP (no port)
  if (net.isIP(ip)) return ip;
  // IPv4 with port: 1.2.3.4:8080
  const lastColon = ip.lastIndexOf(':');
  if (lastColon > -1 && ip.includes('.') && ip.indexOf(':') === lastColon) {
    const candidate = ip.slice(0, lastColon);
    if (net.isIP(candidate) === 4) return candidate;
  }
  return ip;
}

/**
 * Check if an IP address is a loopback address.
 * Handles: 127.x.x.x, ::1, ::ffff:127.x.x.x
 */
export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  if (ip === '127.0.0.1') return true;
  if (ip.startsWith('127.')) return true;
  if (ip === '::1') return true;
  if (ip.startsWith('::ffff:127.')) return true;
  return false;
}

/**
 * Parse the client IP from X-Forwarded-For header.
 * Takes the FIRST entry (leftmost = original client).
 */
export function parseForwardedForClientIp(forwardedFor?: string): string | undefined {
  const raw = forwardedFor?.split(',')[0]?.trim();
  if (!raw) return undefined;
  return normalizeIp(stripOptionalPort(raw));
}

/**
 * Parse the client IP from X-Real-IP header.
 */
function parseRealIp(realIp?: string): string | undefined {
  const raw = realIp?.trim();
  if (!raw) return undefined;
  return normalizeIp(stripOptionalPort(raw));
}

/**
 * Resolve the real client IP from an HTTP request.
 *
 * Priority:
 * 1. If remote address is NOT a trusted proxy, return it directly
 * 2. If behind trusted proxy, check X-Forwarded-For, then X-Real-IP
 * 3. Fall back to remote address
 */
export function resolveClientIp(params: {
  remoteAddr?: string;
  forwardedFor?: string;
  realIp?: string;
  trustedProxies?: string[];
}): string | undefined {
  const remote = normalizeIp(params.remoteAddr);
  if (!remote) return undefined;

  // If no trusted proxies configured, or remote is not a trusted proxy,
  // return the remote address directly
  const proxies = params.trustedProxies;
  if (!proxies || proxies.length === 0) {
    // In production behind a load balancer, trust X-Forwarded-For by default
    return parseForwardedForClientIp(params.forwardedFor) ?? remote;
  }

  const isTrusted = proxies.some(proxy => normalizeIp(proxy) === remote);
  if (!isTrusted) return remote;

  return parseForwardedForClientIp(params.forwardedFor) ?? parseRealIp(params.realIp) ?? remote;
}

/**
 * Express middleware helper: extract real client IP from request.
 */
export function getClientIp(req: { ip?: string; headers: Record<string, string | string[] | undefined> }): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  const realIp = req.headers['x-real-ip'];

  return resolveClientIp({
    remoteAddr: req.ip,
    forwardedFor: Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor,
    realIp: Array.isArray(realIp) ? realIp[0] : realIp,
  }) || req.ip || 'unknown';
}
