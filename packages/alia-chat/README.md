# @alia.onl/sdk

Alia's chat SDK for React Native and Expo apps built on Oxy: the chat sheet and
screen, the streaming hook, speech in and out, and the primitives they are made
of. It renders inside the one `OxyProvider` your app already mounts and sends
the signed-in user's Oxy session with every request; it never holds a token of
its own.

The package ships **raw TypeScript source** — `main`, `types` and every
`exports` entry point at `src/`. Your bundler compiles it with the rest of your
app, which is why the section on endpoints below matters more than it would for
a prebuilt library.

## Install

```sh
bun add @alia.onl/sdk
```

`react`, `react-native`, `@oxy.so/core`, `@oxy.so/services` and the Expo modules
listed under `peerDependencies` in `package.json` are yours to install. Metro
must resolve package `exports` (`resolver.unstable_enablePackageExports = true`,
the default in Expo SDK 53+), because every icon import is a subpath.

Two entry points:

- `@alia.onl/sdk` — text chat, speech, catalogue, primitives. Never reaches
  `livekit-client`.
- `@alia.onl/sdk/voice` — `VoiceSession`, the LiveKit half. Pass it to the shell
  as `voiceSession` to offer calls; leave it out for text-only chat.

## Use

```tsx
import { AliaChatScreen } from '@alia.onl/sdk';

export function Assistant() {
  return <AliaChatScreen />;
}
```

Or the hook on its own, with your own UI:

```tsx
import { useAliaChat } from '@alia.onl/sdk';

const { messages, send, isStreaming, stop, error } = useAliaChat({
  clientContext: 'The user is looking at their order history.',
});
```

`useAliaChat` streams a turn as Server-Sent Events and switches on Alia's
product events — `alia.reasoning`, `alia.tool_result`, `alia.research_progress`,
`alia.plan_preview`, delegated-agent answers — into `ChatMessage` fields your
components render. Those events are the product runtime's, not part of the Oxy
generic inference contract, and this package is written against them on
purpose: it is a **product** client.

## Which endpoint the SDK calls, and why

The hook sends its turns to `POST {apiUrl}/v1/chat/completions`, with `apiUrl`
defaulting to `EXPO_PUBLIC_ALIA_API_URL` or `https://api.alia.onl`. It also
reads `GET {apiUrl}/catalogue` once per base URL, to check the requested model
identifier against what the server offers.

That is the compatibility surface, not the product route. `POST /alia/chat` is
the same handler with the same authentication, and it is where Alia's own
clients go — but the two mounts answer browsers differently:

| Preflight | `access-control-allow-origin` |
| --- | --- |
| `OPTIONS /alia/chat` from `https://alia.onl` or `https://console.alia.onl` | that origin, with credentials |
| `OPTIONS /alia/chat` from an origin Alia does not enumerate | **absent** |
| `OPTIONS /v1/chat/completions` from anywhere | `*` |

`/alia/chat` takes Alia's exact-origin allowlist (`packages/api/src/lib/cors-origins.ts`);
`/v1` is public CORS. Because this package compiles into *your* app on *your*
origin, defaulting the hook to `/alia/chat` would fail every consumer's
preflight on web. So it stays on `/v1/chat/completions`, which is Alia's
**permanent product API** — it does not sunset
([ADR 0010](https://github.com/OxyHQ/Alia/blob/main/docs/adr/0010-alia-keeps-a-product-api-credentials-come-from-oxy-console.md)).
Generic model access is a different product, Kaana through Oxy; this package
is written against Alia's, and the credential a consumer presents is an Oxy
one — the signed-in user's session today. A change of default to `/alia/chat`
would be a semver-major of this package, would reach only consumers who upgrade
**and** rebuild, and is not needed to escape a sunset; it is taken only if the
per-application origin policy below makes it worthwhile
([#244](https://github.com/OxyHQ/Alia/issues/244), closed on that decision).

Native apps are not subject to CORS at all — React Native sends no `Origin`
header — so the table above is about web builds and the backend path below.

## Using the SDK from your own product: the consumer-backend path

The supported way for an application outside Alia's origins to use this SDK
today is to put your own backend between the SDK and Alia. Your backend
receives the SDK's request, calls Alia's product route server-to-server — a
server sends no `Origin` header, so `/alia/chat` answers it on its credential
alone — and streams the SSE body back unchanged. Then point the hook at that
backend:

```tsx
useAliaChat({ apiUrl: 'https://your-backend.example' });
```

The hook keeps its paths, so your backend answers
`POST /v1/chat/completions` and `GET /catalogue` under whatever base URL you
give it. Nothing about the stream changes: the SDK's parser reads the bytes Alia
wrote.

**Which credential.** The SDK attaches the signed-in user's Oxy access token as
`Authorization: Bearer …` on the request your backend receives. Forward that
header as it is. `POST /alia/chat` authenticates with
`authenticateTokenOrApiKey` (`packages/api/src/routes/chat.ts`,
`packages/api/src/middleware/auth.ts`), which accepts an Oxy session token —
verified with Oxy, the same way it would be if the browser had called Alia
directly — and the turn is metered to that user's Alia entitlement, the same as
a direct call. The route also accepts an existing `alia_sk_*` developer key,
but Alia issues no new ones and that credential is inside its own sunset
window, so do not build on one; the remaining credentials the middleware
recognises are Alia-internal. There is no consumer-application credential for
this route yet — that is Oxy Applications' to issue (OxyHQ/oxy#972).

A minimal relay, Node 18+ and Express:

```ts
import express from 'express';

const ALIA = 'https://api.alia.onl';
const app = express();
app.use(express.json({ limit: '1mb' }));

/** Relay one request to Alia and stream the answer back unchanged. */
async function relay(
  req: express.Request,
  res: express.Response,
  method: 'GET' | 'POST',
  path: string,
): Promise<void> {
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const authorization = req.get('authorization');
  const upstream = await fetch(`${ALIA}${path}`, {
    method,
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      Accept: req.get('accept') ?? 'application/json',
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: method === 'POST' ? JSON.stringify(req.body) : undefined,
    signal: controller.signal,
  });

  res.status(upstream.status);
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // keep proxies from buffering the SSE stream
  res.flushHeaders();

  if (upstream.body === null) {
    res.end();
    return;
  }
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    res.end();
  }
}

// The SDK's turn: answered by Alia's PRODUCT route, server-to-server.
app.post('/v1/chat/completions', (req, res) => relay(req, res, 'POST', '/alia/chat'));

// The SDK's model check. Without this the hook still works — an unreadable
// catalogue leaves the requested identifier alone — but it never learns what
// the server offers.
app.get('/catalogue', (req, res) => relay(req, res, 'GET', '/catalogue'));

app.listen(3000);
```

The request body the SDK sends is `{ model, messages, stream: true }` and the
response Alia writes is `text/event-stream`; the relay forwards both without
reading them. CORS between your web app and your backend is yours to configure,
as it would be for any of your own routes.

**The trade-off.** This is one more hop, and one more process in the path of a
stream. Some consumers will not want it, which is why it is documented as the
path that works today rather than chosen as the only one. The other two shapes
— a CORS policy on `/alia/chat` for registered consumer origins, and the SDK
default moving to `/alia/chat` in a major — are recorded in #244: the first is
blocked on Oxy Applications carrying an origin registry (OxyHQ/oxy#972), and
the second is an adoption window rather than a switch, for the raw-source
reason above.

## Scripts

```sh
bun run typecheck       # tsc --noEmit
bun run test            # vitest
bun run check:entries   # the root entry must not reach livekit-client
```

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`.
