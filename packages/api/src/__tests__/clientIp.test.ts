/**
 * `req.ip` is the real client behind the ALB, and behind Cloudflare in front of
 * it once the hostname is proxied.
 *
 * The ALB appends to X-Forwarded-For, so the app sees `<client>` on a DNS-only
 * hostname (grey) and `<client>, <cloudflare edge>` on a proxied one (orange).
 * `trust proxy = 1` would answer the edge for orange; no trust proxy at all
 * answers the ALB for both. `oxyTrustProxy` from `@oxy.so/core/server` answers
 * the client in both shapes and never believes an entry the caller wrote.
 *
 * The requests below arrive from 127.0.0.1, a private peer standing in for the
 * ALB, through a real socket.
 */
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { oxyTrustProxy } from '@oxy.so/core/server';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', oxyTrustProxy);
  app.get('/ip', (req, res) => {
    res.json({ ip: req.ip });
  });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function ipFor(forwardedFor?: string): Promise<string> {
  const response = await fetch(`${baseUrl}/ip`, {
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  });
  const body = (await response.json()) as { ip: string };
  return body.ip;
}

describe('client address behind the proxy chain', () => {
  it('grey: the address the ALB saw is the client', async () => {
    expect(await ipFor('203.0.113.7')).toBe('203.0.113.7');
  });

  it('orange: the address Cloudflare appended is the client, not the edge', async () => {
    expect(await ipFor('203.0.113.7, 172.70.1.2')).toBe('203.0.113.7');
  });

  it('a forged entry left of the trusted hops is never believed', async () => {
    expect(await ipFor('198.51.100.66, 203.0.113.7')).toBe('203.0.113.7');
    expect(await ipFor('198.51.100.66, 203.0.113.7, 172.70.1.2')).toBe('203.0.113.7');
  });

  it('with no header the peer itself is the client', async () => {
    expect(await ipFor()).toBe('127.0.0.1');
  });
});

describe('the API process', () => {
  const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');

  it('trusts the proxy chain with oxyTrustProxy, before any middleware', () => {
    const trust = source.indexOf("app.set('trust proxy', oxyTrustProxy)");
    const firstUse = source.search(/\bapp\.use\(/);
    expect(trust).toBeGreaterThan(-1);
    expect(firstUse).toBeGreaterThan(trust);
    expect(source.match(/'trust proxy'/g)).toHaveLength(1);
  });
});
