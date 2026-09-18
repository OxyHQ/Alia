# @alia.onl/server

## 1.0.1

### A CommonJS consumer can compile against it

1.0.0 was unusable from the consumer it was written for. Its `exports["."]`
carried ONE `types` entry for both conditions, pointing at `dist/index.d.ts` —
and in a `"type": "module"` package that is an ES module declaration, so a
consumer whose tsconfig says `module: Node16` got **TS1479**: *"the referenced
file is an ECMAScript module and cannot be imported with `require`"*.

The runtime was fine the whole time. Node read `require` → `dist/index.cjs` and
never looked at the types, which is why this package's own typecheck, tests and
build all passed, and why every bundler-based consumer would have been fine too.
The first backend to try it could not compile.

Each condition now carries its own `types` — `.d.ts` for `import`, `.d.cts` for
`require` — and `scripts/check-entrypoints.mjs` runs in CI: it asserts the
shipped shape, loads both entry points, and compiles a real CommonJS `node16`
consumer against a real `node_modules` layout. (Against a `paths` alias it
compiled the broken shape clean, because TypeScript applies an `exports` map
only when it resolves through `node_modules` — so that probe proved nothing and
was replaced.)

No API change.

## 1.0.0

### A server-side client, so no consumer hand-parses Alia's stream again

`@alia.onl/sdk` is a client SDK — React, React Native, hooks, a browser stream
reader — and there was nothing for the other side. Every product whose backend
calls Alia wrote its own SSE parser, and each one got a different subset of the
wire right.

The expensive part was never the framing. It was that Alia writes an error INTO
the stream (`{"error":{"code":"agent_unavailable"}}`, followed by `[DONE]`), and
a parser written against text deltas has no branch for it: it either throws
something that names nothing, or skips the frame and reports an empty answer.
Homiio shipped both failures in one week, and the second one was invisible for
hours.

So this package makes every shape on that wire a typed event — `text`,
`reasoning`, `event`, `finish`, `error`, `done` — over a closed union, and owns
content-type checking, SSE framing, `[DONE]`, abort, and a typed
`AliaRequestError` for a non-2xx answer. A consumer can be wrong about what to
DO with an error; it can no longer fail to see one.

Text deltas are yielded verbatim and never merged: a consumer reassembling
markers that span chunk boundaries depends on the exact bytes.

Node 22+, no dependencies, ESM and CommonJS.
