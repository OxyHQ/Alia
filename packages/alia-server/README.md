# @alia.onl/server

Alia's client for the **backend** that calls Alia on a person's behalf.

`@alia.onl/sdk` is the client SDK: React and React Native components, hooks, a
browser-side stream reader. This package is the other half — no React, no DOM
beyond `fetch` and `ReadableStream`, no dependencies, Node 22+. It POSTs one
turn to `/v1/chat/completions` and gives you a typed async iterable of what Alia
wrote.

## Why it exists

Alia can write these things on that stream:

| On the wire | What it is |
| --- | --- |
| `data: {…choices[0].delta.content}` | an assistant text delta |
| `data: {…choices[0].delta.reasoning}` | a reasoning delta |
| `event: alia.tool_result` + `data: {…}` | a named product event |
| `data: {…, "alia_meta": {"synthetic": true}}` | a stand-in message an **older** server wrote after a provider died; current servers end a failed turn with the error payload below |
| `data: {"error":{"code":"agent_unavailable"}}` | Alia refusing, mid-stream |
| `data: [DONE]` | the terminator |

Every consumer that called Alia from a server wrote its own reader for that, and
each got a different subset right. The expensive one is the error payload: a
reader with no branch for it either throws a bare 502 that names nothing, or —
worse — skips the frame it does not recognise and reports an empty answer. Both
happened in production. This package makes that shape a typed `error` event
carrying the server's own `code`, so a consumer cannot fail to see it.

## Install

```sh
bun add @alia.onl/server   # or npm / pnpm / yarn
```

## Use

```ts
import { AliaServerClient } from '@alia.onl/server';

const alia = new AliaServerClient({
  baseUrl: 'https://api.alia.onl',
  // Your product's Oxy service token — the bearer Oxy bills (ADR 0007).
  token: () => getMyServiceToken(),
});

const stream = await alia.stream(
  { agentId: MY_AGENT_ID, messages: [{ role: 'user', content: 'Hola' }] },
  { signal: request.signal },
);

for await (const event of stream) {
  switch (event.type) {
    case 'text':      process.stdout.write(event.text); break;
    case 'reasoning': break;
    case 'event':     onProductEvent(event.event, event.data); break;
    case 'finish':    break;
    case 'error':     throw new MyChatError(event.code);   // the SERVER's code
    case 'done':      break;
  }
}
```

The `switch` above is exhaustive: `AliaStreamEvent` is a closed union, so a
`default: never` branch makes a new event kind a compile error rather than a
silently dropped frame.

### What it owns

- **Content-type checking.** A 200 that is not `text/event-stream` is an
  `AliaStreamError('not_event_stream')`, never a buffered fallback parse.
- **SSE framing.** Multi-line `data:`, comment frames, CRLF, `event: message`
  as SSE's default name, and byte boundaries falling anywhere — including
  mid-UTF-8. **Text deltas are yielded verbatim and never merged**, because a
  consumer reassembling markers across chunks depends on the exact bytes.
- **`[DONE]`.** Iteration ends on it. A body that ends without it is an
  `AliaStreamError('truncated')` — a truncated turn must not read as a short one.
- **Error chunks**, as `error` events carrying `code`, `message`, `type`, `param`.
- **Abort.** Pass an `AbortSignal`; the request and the body read both stop, and
  leaving the `for await` early cancels the body.
- **Non-2xx**, as `AliaRequestError` with `status` and, when the body carried
  one, `code`. The body's prose is deliberately not retained.

### Errors

```ts
import { AliaRequestError, AliaStreamError } from '@alia.onl/server';
```

`AliaStreamError` carries `failure` (one of `not_event_stream`, `no_body`,
`malformed_json`, `unexpected_chunk`, `choice_without_delta`,
`content_not_string`, `truncated`, `oversized`) and `shape` — the offending
chunk's keys, its `choices` length or type, and any `error.code`. `shape` holds
no content: not the assistant's text, not the person's prompt. Log it whole.

`AliaRequestError` carries `status` and `code`.

An abort throws an `Error` whose `name` is `AbortError`, as `fetch`'s does.

### Bring your own request

```ts
import { readAliaEventStream } from '@alia.onl/server';

for await (const event of readAliaEventStream(response.body!, { signal })) { … }
```

## Which credential

Alia receives the calling product's **Oxy service token** as the bearer. A
person's own bearer is never forwarded. A turn for a signed-in person does not
go through a product backend at all: the person opens the agent with their own
Oxy session through `@alia.onl/sdk` (Alia ADR 0020). `headers` accepts a
function for a header whose value changes on every request.

## Tests

The test fixtures are not hand-written chunks. They are produced by the API's
own SSE writers — `packages/api/src/lib/streaming-helpers.ts`,
`.../chat/sse-writer.ts`, `.../sse-emitter.ts` — imported directly, so a change
to what Alia puts on the wire fails this package's tests in the same commit.

```sh
bun run typecheck
bun run test
bun run build
```

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`.


## Explicit Stop (1.3)

For a verified human session or exact app-only credential, choose a UUID v4 before
`stream()` and supply `turnId`. `cancelTurn({ turnId, conversationId })` uses the
same authentication and surface headers; `conversationId` must be the value
known at admission, including absence for a new conversation. Its signal is
independent of the stream's AbortSignal. Aborting the latter only detaches the
reader and allows background completion.

`createAliaTurnControl(client, { controller, lifetimeSignal, conversationId })` creates the UUID
before any asynchronous preparation. Send its `id` as the request's `turnId`;
call `stop()` only for deliberate Stop. It deduplicates concurrent Stop calls,
waits up to ten seconds for acknowledgement, and only then aborts the controller.
A refused Stop rejects and remains retryable. Abort the stream controller directly for view teardown. The separate
`lifetimeSignal` fences account changes or disposal of its authenticated owner;
it must not be the stream signal, because a cancellation SSE frame can close the
stream before the control request is acknowledged. The helper never refreshes or
chooses an account.
Await `finish()` before disposing the caller's linked transport. Each HTTP tool
continuation gets a new handle, and stopping a local tool prevents further rounds
without undoing work that already ran.

Deploy the API receiver before adopting this producer. Delegated service/channel
callers without a verifiable original actor must omit `turnId`; their existing
chat remains supported, but they cannot use this cancellation lane. Details and
settlement/retry limits: [explicit Stop](../../docs/explicit-chat-stop.md).
