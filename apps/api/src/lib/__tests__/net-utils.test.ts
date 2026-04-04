import { describe, it, expect } from 'vitest';
import {
  isLoopbackAddress,
  parseForwardedForClientIp,
  resolveClientIp,
  getClientIp,
} from '../net-utils.js';

describe('net-utils', () => {
  describe('isLoopbackAddress', () => {
    it('detects IPv4 loopback', () => {
      expect(isLoopbackAddress('127.0.0.1')).toBe(true);
      expect(isLoopbackAddress('127.0.0.2')).toBe(true);
      expect(isLoopbackAddress('127.255.255.255')).toBe(true);
    });

    it('detects IPv6 loopback', () => {
      expect(isLoopbackAddress('::1')).toBe(true);
    });

    it('detects IPv4-mapped IPv6 loopback', () => {
      expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
      expect(isLoopbackAddress('::ffff:127.0.0.2')).toBe(true);
    });

    it('returns false for non-loopback', () => {
      expect(isLoopbackAddress('192.168.1.1')).toBe(false);
      expect(isLoopbackAddress('10.0.0.1')).toBe(false);
      expect(isLoopbackAddress('8.8.8.8')).toBe(false);
    });

    it('handles undefined and empty', () => {
      expect(isLoopbackAddress(undefined)).toBe(false);
      expect(isLoopbackAddress('')).toBe(false);
    });
  });

  describe('parseForwardedForClientIp', () => {
    it('extracts first IP from X-Forwarded-For', () => {
      expect(parseForwardedForClientIp('203.0.113.50')).toBe('203.0.113.50');
      expect(parseForwardedForClientIp('203.0.113.50, 70.41.3.18, 150.172.238.178')).toBe('203.0.113.50');
    });

    it('normalizes IPv4-mapped IPv6', () => {
      expect(parseForwardedForClientIp('::ffff:203.0.113.50')).toBe('203.0.113.50');
    });

    it('handles port in IP', () => {
      expect(parseForwardedForClientIp('203.0.113.50:8080, 70.41.3.18')).toBe('203.0.113.50');
    });

    it('handles bracketed IPv6 with port', () => {
      expect(parseForwardedForClientIp('[::1]:8080')).toBe('::1');
    });

    it('returns undefined for empty/missing', () => {
      expect(parseForwardedForClientIp(undefined)).toBeUndefined();
      expect(parseForwardedForClientIp('')).toBeUndefined();
    });
  });

  describe('resolveClientIp', () => {
    it('uses X-Forwarded-For by default (behind load balancer)', () => {
      const ip = resolveClientIp({
        remoteAddr: '10.0.0.1',
        forwardedFor: '203.0.113.50, 10.0.0.1',
      });
      expect(ip).toBe('203.0.113.50');
    });

    it('falls back to remote address when no forwarded header', () => {
      const ip = resolveClientIp({
        remoteAddr: '203.0.113.50',
      });
      expect(ip).toBe('203.0.113.50');
    });

    it('trusts proxy only when configured', () => {
      const ip = resolveClientIp({
        remoteAddr: '10.0.0.1',
        forwardedFor: '203.0.113.50',
        trustedProxies: ['10.0.0.1'],
      });
      expect(ip).toBe('203.0.113.50');
    });

    it('ignores X-Forwarded-For from untrusted source when proxies configured', () => {
      const ip = resolveClientIp({
        remoteAddr: '192.168.1.100',
        forwardedFor: '203.0.113.50',
        trustedProxies: ['10.0.0.1'], // Different from remoteAddr
      });
      expect(ip).toBe('192.168.1.100');
    });

    it('returns undefined when no remote address', () => {
      const ip = resolveClientIp({});
      expect(ip).toBeUndefined();
    });
  });

  describe('getClientIp', () => {
    it('extracts IP from Express-like request', () => {
      const req = {
        ip: '10.0.0.1',
        headers: { 'x-forwarded-for': '203.0.113.50' },
      };
      expect(getClientIp(req)).toBe('203.0.113.50');
    });

    it('falls back to req.ip', () => {
      const req = {
        ip: '203.0.113.50',
        headers: {},
      };
      expect(getClientIp(req)).toBe('203.0.113.50');
    });

    it('returns unknown when no IP available', () => {
      const req = { headers: {} };
      expect(getClientIp(req)).toBe('unknown');
    });
  });
});
