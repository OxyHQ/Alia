/**
 * The one fetch every connector request leaves this host through.
 *
 * A remote connector's URL is a person's choice, and so is everything its server
 * points at afterwards: OAuth metadata, authorization servers, token and
 * revocation endpoints, redirects. This host runs inside the VPC, where the
 * cloud metadata service and every private range answer, so each of those
 * requests is made with the SDK's `safeFetch` (`@oxy.so/core/server`): every
 * hop's address is resolved and judged, and the connection is pinned to the
 * address that was judged, which closes the DNS-rebinding window a check made
 * before an ordinary `fetch` leaves open. Only https is reached.
 *
 * The MCP SDK's transports and `auth()` take a WHATWG `fetch`, so this adapts
 * the request to `safeFetch` and its Node response back to a `Response`. The
 * body is streamed, not buffered: a streamable-HTTP or SSE connection is a
 * long-lived stream, and the caller's signal still ends it.
 */

import { Readable } from 'node:stream';
import { safeFetch, SsrfRejection } from '@oxy.so/core/server';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * How long a connector may take to answer with its headers. A tool call over
 * streamable HTTP may answer with plain JSON only once the tool has finished,
 * so this is the tool call's budget, not a connect timeout.
 */
const CONNECTOR_HEADERS_TIMEOUT_MS = 120_000;

/** Statuses a `Response` must be built without a body for. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

export const connectorFetch: FetchLike = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).protocol !== 'https:') {
    throw new SsrfRejection('a connector is reached over https only');
  }

  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  const { response, status, headers } = await safeFetch(request.url, {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    ...(body ? { body } : {}),
    ...(init?.redirect === 'manual' ? { redirect: 'manual' as const } : {}),
    ...(init?.redirect === 'error' ? { maxRedirects: 0 } : {}),
    headersTimeoutMs: CONNECTOR_HEADERS_TIMEOUT_MS,
    ...(init?.signal ? { signal: init.signal } : {}),
  });

  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item);
  }

  if (NULL_BODY_STATUSES.has(status)) {
    response.destroy();
    return new Response(null, { status, headers: responseHeaders });
  }
  return new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
    status,
    headers: responseHeaders,
  });
};
