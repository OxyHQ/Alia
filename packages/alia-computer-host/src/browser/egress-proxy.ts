/**
 * The agents' browser's only way out: an HTTP proxy that admits public
 * HTTP(S) and connects to the exact address it validated.
 *
 * Adapted from OpenMuse `apps/worker/src/proxy.ts` (MIT, see ../../NOTICE).
 *
 * It runs in its OWN container (`browser-isolation.ts`), the only member of the
 * browser's internal Docker network that also has a route out. Chromium is
 * pointed at it with no bypass and cannot resolve names itself, so every byte
 * the browser sends to the internet passes through {@link destinationFor}:
 *
 *  - plain HTTP is forwarded as an absolute-URI request to the pinned address,
 *    with the original Host header and hop-by-hop headers removed;
 *  - HTTPS is a CONNECT tunnel to port 443 only, to the pinned address;
 *  - anything else (CONNECT to 80 or 22, a relative URL, a private answer) is a
 *    403, and the destination is never dialled.
 *
 * QUIC (UDP) never reaches it because Chromium runs with `--disable-quic`, and
 * WebRTC is limited to proxied TCP. The proxy cannot help either: its container
 * has nothing listening for UDP.
 */
import { once } from 'node:events';
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type RequestOptions,
} from 'node:http';
import { connect, type Socket } from 'node:net';
import { destinationFor, type Cidr4, type HostResolver } from './network.js';

/** On the proxy's own 403 to a plain-HTTP request; HTTPS refusals fail the tunnel instead. */
export const REFUSAL_HEADER = 'x-alia-egress';

const HOP_BY_HOP = [
  'connection',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
];

export interface EgressProxyOptions {
  resolve: HostResolver;
  extraDenied?: readonly Cidr4[];
  /** 0 picks a free port (tests). */
  port?: number;
  host?: string;
  /** Simultaneous client connections; Chromium opens ~6 per origin. */
  maxConnections?: number;
  /** Injected in tests so a "public" address can be served locally. */
  sendHttp?: (
    options: RequestOptions,
    onResponse: (response: IncomingMessage) => void,
  ) => ClientRequest;
  connectTcp?: (options: { host: string; port: number; family: 4 | 6 }) => Socket;
  /** Called with each refusal, for the log; never with a URL path or query. */
  onRefused?: (reason: string, host: string) => void;
}

export interface EgressProxy {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const sockets = new Set<Socket>();
  const extraDenied = options.extraDenied ?? [];
  const sendHttp = options.sendHttp ?? httpRequest;
  const connectTcp =
    options.connectTcp ??
    ((target) => connect({ host: target.host, port: target.port, family: target.family }));
  const refused = (reason: string, host: string) => options.onRefused?.(reason, host);

  const server = createServer(async (incoming, response) => {
    let host = '';
    try {
      const raw = incoming.url ?? '';
      host = (() => {
        try {
          return new URL(raw).host;
        } catch {
          return '';
        }
      })();
      const target = await destinationFor(raw, options.resolve, extraDenied);
      if (target.url.protocol !== 'http:')
        throw new Error('An HTTP proxy request must name an http: URL');
      const headers: OutgoingHttpHeaders = { ...incoming.headers, host: target.url.host };
      for (const name of HOP_BY_HOP) delete headers[name];
      const upstream = sendHttp(
        {
          host: target.address,
          family: target.family,
          port: target.port,
          path: `${target.url.pathname}${target.url.search}`,
          method: incoming.method,
          headers,
          timeout: 30_000,
          agent: false,
        },
        (result) => {
          const responseHeaders = { ...result.headers };
          for (const name of HOP_BY_HOP) delete responseHeaders[name];
          delete responseHeaders[REFUSAL_HEADER];
          response.writeHead(result.statusCode ?? 502, responseHeaders);
          result.on('error', () => response.destroy());
          result.pipe(response);
        },
      );
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      incoming.on('aborted', () => upstream.destroy());
      response.on('close', () => upstream.destroy());
      incoming.pipe(upstream);
    } catch (error) {
      refused(error instanceof Error ? error.message : 'refused', host);
      // Marked, so the worker can tell a refusal from a site's own 403.
      if (!response.headersSent)
        response.writeHead(403, { 'content-type': 'text/plain', [REFUSAL_HEADER]: 'refused' });
      response.end('Destination blocked');
    }
  });

  server.on('connect', async (request: IncomingMessage, client: Socket, head: Buffer) => {
    client.on('error', () => client.destroy());
    const authority = request.url ?? '';
    try {
      // Port 443 only: a tunnel to 80 would carry plain HTTP past the request
      // path above, and a tunnel anywhere else is not the web.
      if (!/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):443$/i.test(authority))
        throw new Error('Only port 443 can be tunnelled');
      const target = await destinationFor(`https://${authority}`, options.resolve, extraDenied);
      if (client.destroyed) return;
      const upstream = connectTcp({ host: target.address, port: 443, family: target.family });
      sockets.add(upstream);
      upstream.setTimeout(120_000, () => upstream.destroy());
      upstream.on('close', () => {
        sockets.delete(upstream);
        client.destroy();
      });
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
    } catch (error) {
      refused(error instanceof Error ? error.message : 'refused', authority.replace(/:\d+$/, ''));
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.maxConnections = options.maxConnections ?? 256;
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;

  server.listen(options.port ?? 0, options.host ?? '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The egress proxy could not listen');
  return {
    url: `http://${options.host ?? '127.0.0.1'}:${address.port}`,
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
