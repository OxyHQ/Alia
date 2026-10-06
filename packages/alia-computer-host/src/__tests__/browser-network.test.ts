/**
 * The browser's network boundary: which addresses are public, which URLs are
 * allowed, and the egress proxy that connects only to the address it checked.
 *
 * The proxy is run for real on loopback. Its upstream connections are
 * injected, so a "public" address can be answered by a local server — the
 * assertion is about WHICH address the proxy dialled, and how many times it
 * asked DNS.
 */
import { once } from 'node:events';
import { createServer as createHttpServer, request as httpRequest, type RequestOptions } from 'node:http';
import { connect, createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startEgressProxy, type EgressProxy } from '../browser/egress-proxy.js';
import {
  allowedUrl,
  destinationFor,
  isPublicIp,
  parseCidr4,
  type HostResolver,
  type ResolvedAddress,
} from '../browser/network.js';
import { upstreamResolvers } from '../browser-stack.js';

describe('isPublicIp', () => {
  it.each([
    '10.0.0.5', '10.255.255.255', '172.16.0.1', '172.31.255.1', '192.168.1.1', '127.0.0.1', '0.0.0.0',
    '169.254.169.254', '169.254.170.2', '100.64.0.1', '100.127.255.255', '192.0.0.1', '192.0.2.1',
    '198.18.0.1', '198.19.255.1', '198.51.100.1', '203.0.113.9', '224.0.0.1', '255.255.255.255', '240.0.0.1',
  ])('refuses the private, link-local or reserved IPv4 %s', (address) => {
    expect(isPublicIp(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '169.255.0.1'])('admits the public IPv4 %s', (address) => {
    expect(isPublicIp(address)).toBe(true);
  });

  it.each([
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    // An IPv4 address wrapped in IPv6 is refused rather than unwrapped.
    '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:8.8.8.8', '::ffff:a00:1',
    '64:ff9b::a00:1', '2002:a00:1::1', '2001:0:1::1', '2001:db8::1', 'fe80::1%eth0',
  ])('refuses the non-global IPv6 %s', (address) => {
    expect(isPublicIp(address)).toBe(false);
  });

  it('admits global unicast IPv6', () => {
    expect(isPublicIp('2606:4700:4700::1111')).toBe(true);
    expect(isPublicIp('2a00:1450:4001:80b::200e')).toBe(true);
  });

  it('refuses whatever the deployment adds', () => {
    const vpc = [parseCidr4('44.0.0.0/8')];
    expect(isPublicIp('44.1.2.3', vpc)).toBe(false);
    expect(isPublicIp('45.1.2.3', vpc)).toBe(true);
  });

  it('refuses things that are not addresses', () => {
    expect(isPublicIp('example.com')).toBe(false);
    expect(isPublicIp('')).toBe(false);
  });
});

describe('allowedUrl', () => {
  it.each([
    'https://example.com/', 'http://example.com:80/a?b=c', 'https://example.com:443/', 'https://93.184.216.34/',
  ])('admits %s', (url) => {
    expect(() => allowedUrl(url)).not.toThrow();
  });

  it.each([
    'file:///etc/passwd', 'ftp://example.com/', 'chrome://settings', 'javascript:alert(1)', 'data:text/html,hi',
    'https://example.com:8443/', 'http://example.com:22/', 'https://user:pass@example.com/',
    'http://localhost/', 'http://printer.local/', 'http://computer.alia.internal/', 'http://router.lan/',
    'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.0.0.1/', 'http://[::ffff:a9fe:a9fe]/',
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => allowedUrl(url)).toThrow(/Only public HTTP/);
  });
});

const fixed = (answers: ResolvedAddress[]): HostResolver => async () => answers;

describe('destinationFor', () => {
  it('pins the validated address, preferring IPv4', async () => {
    const destination = await destinationFor(
      'https://example.com/x',
      fixed([{ address: '2606:2800:220:1::1', family: 6 }, { address: '93.184.216.34', family: 4 }]),
    );
    expect(destination).toMatchObject({ address: '93.184.216.34', family: 4, port: 443, hostname: 'example.com' });
  });

  it('refuses a name when ANY answer is private — the hedge a rebinding resolver makes', async () => {
    await expect(
      destinationFor('https://rebind.example/', fixed([{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }])),
    ).rejects.toMatchObject({ code: 'blocked_url' });
    await expect(destinationFor('https://internal.example/', fixed([{ address: '10.1.2.3', family: 4 }])))
      .rejects.toMatchObject({ code: 'blocked_url' });
  });

  it('reports a name that does not resolve, or resolves too slowly, as DNS unavailable', async () => {
    await expect(destinationFor('https://nx.example/', fixed([]))).rejects.toMatchObject({ code: 'dns_unavailable' });
    await expect(destinationFor('https://slow.example/', () => new Promise(() => undefined), [], 20))
      .rejects.toMatchObject({ code: 'dns_unavailable' });
  });

  it('does not ask DNS about a literal address', async () => {
    let asked = 0;
    const resolver: HostResolver = async () => {
      asked += 1;
      return [];
    };
    await expect(destinationFor('http://93.184.216.34/', resolver)).resolves.toMatchObject({ address: '93.184.216.34' });
    expect(asked).toBe(0);
  });
});

describe('upstreamResolvers', () => {
  it('reads the IPv4 nameservers and drops loopback stubs', () => {
    const conf = '# generated\nnameserver 127.0.0.53\nnameserver 10.0.0.2\nnameserver fd00::2\nsearch us-west-2.compute.internal\n';
    expect(upstreamResolvers(conf)).toEqual(['10.0.0.2']);
  });
});

// ── The proxy, for real ──────────────────────────────────────────────────

let proxy: EgressProxy | null = null;
let upstream: Server | null = null;

afterEach(async () => {
  await proxy?.close();
  proxy = null;
  if (upstream) {
    upstream.close();
    upstream = null;
  }
});

/** A TCP echo-ish server standing in for "the public internet". */
async function fakeInternet(): Promise<number> {
  upstream = createServer((socket) => {
    socket.once('data', () => socket.end('upstream-hello'));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  return (upstream.address() as { port: number }).port;
}

function connectThrough(port: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let data = '';
    let tunnelled = false;
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (!tunnelled && data.includes('200 Connection Established')) {
        tunnelled = true;
        socket.write('client-hello');
      }
    });
    socket.on('end', () => resolve(data));
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
  });
}

describe('the egress proxy', () => {
  it('tunnels HTTPS to exactly the address it validated, resolving the name once', async () => {
    const port = await fakeInternet();
    const lookups: string[] = [];
    let answer = 0;
    // A rebinding resolver: public first, private every time after.
    const resolver: HostResolver = async (hostname) => {
      lookups.push(hostname);
      answer += 1;
      return [{ address: answer === 1 ? '93.184.216.34' : '169.254.169.254', family: 4 }];
    };
    const dialled: string[] = [];
    proxy = await startEgressProxy({
      resolve: resolver,
      connectTcp: (target) => {
        dialled.push(`${target.host}:${target.port}`);
        return connect(port, '127.0.0.1');
      },
    });
    const reply = await connectThrough(proxy.port, 'rebind.example:443');
    expect(reply).toContain('200 Connection Established');
    expect(reply).toContain('upstream-hello');
    expect(lookups).toEqual(['rebind.example']);
    expect(dialled).toEqual(['93.184.216.34:443']);
  });

  it('refuses a tunnel to anything but port 443, and to a private answer, without dialling', async () => {
    const dialled: string[] = [];
    proxy = await startEgressProxy({
      resolve: fixed([{ address: '10.0.0.7', family: 4 }]),
      connectTcp: (target) => {
        dialled.push(target.host);
        return connect(1, '127.0.0.1');
      },
    });
    expect(await connectThrough(proxy.port, 'example.com:80')).toContain('403');
    expect(await connectThrough(proxy.port, 'example.com:22')).toContain('403');
    expect(await connectThrough(proxy.port, 'postgres.internal.example:443')).toContain('403');
    expect(await connectThrough(proxy.port, '169.254.169.254:443')).toContain('403');
    expect(dialled).toEqual([]);
  });

  it('forwards plain HTTP to the pinned address with the original Host and no proxy credentials', async () => {
    const seen: { host?: string; auth?: string; url?: string }[] = [];
    const web = createHttpServer((req, res) => {
      seen.push({ host: req.headers.host, auth: req.headers['proxy-authorization'] as string | undefined, url: req.url });
      res.end('ok');
    });
    web.listen(0, '127.0.0.1');
    await once(web, 'listening');
    const webPort = (web.address() as { port: number }).port;
    const sent: RequestOptions[] = [];
    proxy = await startEgressProxy({
      resolve: fixed([{ address: '93.184.216.34', family: 4 }]),
      sendHttp: (options, onResponse) => {
        sent.push(options);
        return httpRequest({ ...options, host: '127.0.0.1', port: webPort, family: 4 }, onResponse);
      },
    });
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: proxy!.port,
        path: 'http://example.com/page?q=1',
        headers: { host: 'example.com', 'proxy-authorization': 'Basic c2VjcmV0' },
      }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    web.close();
    expect(status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ host: '93.184.216.34', port: 80, path: '/page?q=1' });
    expect(seen).toEqual([{ host: 'example.com', auth: undefined, url: '/page?q=1' }]);
  });

  it('answers 403 to a plain request for a private or metadata address', async () => {
    let sent = 0;
    proxy = await startEgressProxy({
      resolve: fixed([{ address: '10.0.0.7', family: 4 }]),
      sendHttp: () => {
        sent += 1;
        throw new Error('must not be called');
      },
    });
    for (const path of ['http://169.254.169.254/latest/meta-data/', 'http://internal.example/', 'https://example.com/']) {
      const status = await new Promise<number>((resolve) => {
        const req = httpRequest({ host: '127.0.0.1', port: proxy!.port, path }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.end();
      });
      expect(status).toBe(403);
    }
    expect(sent).toBe(0);
  });
});

