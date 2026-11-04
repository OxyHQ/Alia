/**
 * A stand-in for `lib/oxy.ts`'s `oxy.withUser(bearer, run)` over a test's own
 * fake client class.
 *
 * Code that asks Oxy AS the person behind a request goes through
 * `oxy.withUser`, which hands `run` a client bound to exactly that bearer. A
 * test replaces that client with its own fake (usually a stand-in
 * `OxyServices` class it controls), and this is the one way it plugs the fake
 * in: a fresh client per call, given the bearer through the same
 * `session.setAccessToken` the fake already records.
 */
export interface FakeUserClient {
  session: { setAccessToken(token: string): unknown };
}

export function fakeWithUser<Client extends FakeUserClient>(
  create: () => Client,
): <T>(bearer: string, run: (client: Client) => Promise<T> | T) => Promise<T> {
  return async (bearer, run) => {
    const client = create();
    client.session.setAccessToken(bearer);
    return await run(client);
  };
}

type Handler = (...args: never[]) => unknown;
type MiddlewareFactory = (...options: never[]) => Handler;

/**
 * A stand-in for `lib/oxy.ts`'s `oxy` that forwards to whichever server a test
 * holds NOW (`current()`), including one it builds after import or swaps per
 * case.
 *
 * Production builds each middleware once, at import (`middleware/auth.ts`,
 * `middleware/channel-auth.ts`, …). A test whose server listens on a port it
 * learns in `beforeAll` cannot exist that early, so `oxy.middleware.<lane>()`
 * here returns a handler that builds the lane from the current server on each
 * request; every other member is read from the current server when used.
 */
export function forwardingOxy(current: () => unknown): never {
  const lane =
    (name: string) =>
    (...options: never[]): Handler =>
    (...args: never[]) => {
      const server = current() as { middleware: Record<string, MiddlewareFactory> } | null;
      if (!server) throw new Error('No Oxy server is configured for this test');
      return server.middleware[name](...options)(...args);
    };
  const middleware = new Proxy({}, { get: (_target, name) => lane(String(name)) });
  return new Proxy(
    {},
    {
      get: (_target, name) => {
        if (name === 'middleware') return middleware;
        const server = current() as Record<PropertyKey, unknown> | null;
        if (!server) return undefined;
        const value = Reflect.get(server, name, server);
        return typeof value === 'function' ? value.bind(server) : value;
      },
    },
  ) as never;
}
