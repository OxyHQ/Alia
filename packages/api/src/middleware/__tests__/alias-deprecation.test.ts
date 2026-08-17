/**
 * The alias deprecation signal.
 *
 * Two things are easy to get wrong here and neither errors at runtime: the two
 * headers have DIFFERENT date syntaxes, and the absence of `Sunset` is a
 * deliberate state rather than a missing feature. Both are asserted directly.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  ALIAS_DEPRECATION,
  ALIAS_SUNSET,
  DEPRECATED_ALIASES,
  aliasDeprecationEvent,
  aliasDeprecationHeaders,
  createAliasDeprecationHeaders,
  namedIdentifiers,
  toHttpDate,
  toStructuredFieldDate,
} from '../alias-deprecation.js';
import { CHAT_EVENT_VERSION } from '../../lib/chat-events.js';

/** The classification the compatibility window publishes to callers, read from disk. */
const MIGRATION_MAP = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../docs/migration/alias-migration-map.json', import.meta.url)),
    'utf8',
  ),
) as { aliases: { alias: string; becomes: { id: string } }[] };

interface Call {
  headers: Record<string, string>;
  nexted: boolean;
}

/**
 * Drive the middleware over a request shape and collect what it set.
 *
 * The REAL middleware runs; only `req` and `res` are stand-ins, and they stand
 * in for exactly the two methods it uses. A test that reimplemented the header
 * logic would measure the reimplementation.
 */
function run(
  handler: (req: Request, res: Response, next: NextFunction) => void,
  req: { body?: unknown; query?: Record<string, string>; path?: string },
): Call {
  const call: Call = { headers: {}, nexted: false };
  const res = {
    setHeader(name: string, value: string) {
      call.headers[name] = value;
    },
  };
  handler(
    { body: req.body, query: req.query ?? {}, path: req.path ?? '/' } as unknown as Request,
    res as unknown as Response,
    (() => {
      call.nexted = true;
    }) as NextFunction,
  );
  return call;
}

describe('the header syntaxes follow their own RFCs', () => {
  it('serializes Deprecation as a structured-field Date (RFC 9745 / RFC 9651)', () => {
    // `@` plus integer epoch SECONDS. Not milliseconds, not an HTTP-date.
    expect(toStructuredFieldDate(new Date('2026-08-15T00:00:00.000Z'))).toBe('@1786752000');
    expect(toStructuredFieldDate(new Date(0))).toBe('@0');
    // Sub-second precision truncates rather than rounding up past the instant.
    expect(toStructuredFieldDate(new Date('2026-08-15T00:00:00.999Z'))).toBe('@1786752000');
  });

  it('serializes Sunset as an HTTP-date (RFC 8594 / RFC 9110 IMF-fixdate)', () => {
    expect(toHttpDate(new Date('2033-12-31T23:59:59.000Z'))).toBe('Sat, 31 Dec 2033 23:59:59 GMT');
  });

  it('the two syntaxes are not interchangeable, which is why they are tested apart', () => {
    // The mistake this guards: emitting one format under the other header. Both
    // read as "a date" in a log, and no client errors — it just cannot parse.
    const when = new Date('2033-12-31T23:59:59.000Z');
    expect(toStructuredFieldDate(when)).not.toBe(toHttpDate(when));
    expect(toStructuredFieldDate(when)).toMatch(/^@-?\d+$/);
    expect(toHttpDate(when)).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
  });
});

describe('what counts as a request naming a deprecated alias', () => {
  it('reads the model out of a JSON body', () => {
    expect(namedIdentifiers({ body: { model: 'alia-v1' }, query: {}, path: '/v1/chat/completions' } as unknown as Request))
      .toContain('alia-v1');
  });

  it('reads it out of a query string and out of a path segment', () => {
    const fromQuery = namedIdentifiers({ body: undefined, query: { model: 'alia-lite' }, path: '/x' } as unknown as Request);
    expect(fromQuery).toContain('alia-lite');
    const fromPath = namedIdentifiers({ body: undefined, query: {}, path: '/v1/models/alia-v1-pro' } as unknown as Request);
    expect(fromPath).toContain('alia-v1-pro');
  });

  it('survives a body that is absent, not an object, or carries a non-string model', () => {
    // Every one of these arrives in production. A throw here would 500 an
    // otherwise fine request, which is a worse outcome than a missing header.
    for (const body of [undefined, null, 'a string', 42, [], { model: 42 }, { model: null }]) {
      expect(() => namedIdentifiers({ body, query: {}, path: '/health' } as unknown as Request)).not.toThrow();
    }
  });
});

describe('the signal is emitted for a deprecated alias and only for one', () => {
  it('sets Deprecation and Link on a request naming any of the thirteen', () => {
    // All thirteen, not one example: an alias missing from the middleware's own
    // list gets no notice at all, silently, for as long as the window runs.
    expect(DEPRECATED_ALIASES.length).toBe(13);
    for (const alias of DEPRECATED_ALIASES) {
      const call = run(aliasDeprecationHeaders, { body: { model: alias }, path: '/v1/chat/completions' });
      expect(call.headers.Deprecation).toBe(toStructuredFieldDate(ALIAS_DEPRECATION));
      expect(call.headers.Link).toMatch(/rel="deprecation"/);
      expect(call.headers.Link).toMatch(/^<https?:\/\/[^>]+>;/);
      expect(call.nexted).toBe(true);
    }
  });

  it('sets nothing on a request that names no alias', () => {
    // The negative control. Without it, a middleware that set the headers
    // unconditionally would pass everything above — and `Deprecation` on every
    // response, including ones with no model in them, is a signal that means
    // nothing.
    for (const req of [
      { body: {}, path: '/health' },
      { body: { model: 'openai/gpt-4o' }, path: '/v1/chat/completions' },
      { body: { model: 'alia-flash' }, path: '/v1/chat/completions' },
      { body: undefined, path: '/v1/chat/completions' },
      { body: undefined, path: '/v1/models' },
    ]) {
      const call = run(aliasDeprecationHeaders, req);
      expect(call.headers).toEqual({});
      expect(call.nexted).toBe(true);
    }
  });

  it('matches an alias exactly, never as a prefix or a substring', () => {
    for (const near of ['alia-v1x', 'xalia-v1', 'alia-v1-', 'ALIA-V1', ' alia-v1']) {
      expect(run(aliasDeprecationHeaders, { body: { model: near }, path: '/v1/chat/completions' }).headers).toEqual({});
    }
  });
});

describe('Sunset is absent until a removal date is set', () => {
  it('emits no Sunset from the instance the server mounts', () => {
    // The assertion that protects production. The compatibility window forbids
    // a placeholder removal date, so the shipped middleware must announce none.
    expect(ALIAS_SUNSET).toBeNull();
    const call = run(aliasDeprecationHeaders, { body: { model: 'alia-v1' }, path: '/v1/chat/completions' });
    expect(call.headers.Deprecation).toBeDefined();
    expect(call.headers.Sunset).toBeUndefined();
    expect(Object.keys(call.headers).sort()).toEqual(['Deprecation', 'Link']);
  });

  it('emits one, correctly serialized, once a date IS configured', () => {
    // The other branch, driven for real rather than promised. A test that could
    // only ever observe the absent case would report "Sunset support works"
    // while the code that emits it had never run.
    const removal = new Date('2033-12-31T23:59:59.000Z');
    const call = run(createAliasDeprecationHeaders(removal), {
      body: { model: 'alia-v1' },
      path: '/v1/chat/completions',
    });
    expect(call.headers.Sunset).toBe('Sat, 31 Dec 2033 23:59:59 GMT');
    expect(call.headers.Deprecation).toBe(toStructuredFieldDate(ALIAS_DEPRECATION));
  });

  it('still emits no Sunset for a request naming no alias, even with a date set', () => {
    const call = run(createAliasDeprecationHeaders(new Date('2033-12-31T23:59:59.000Z')), {
      body: { model: 'openai/gpt-4o' },
      path: '/v1/chat/completions',
    });
    expect(call.headers).toEqual({});
  });
});

describe('the stream event carries the same notice to a caller that reads only the body', () => {
  /**
   * `docs/migration/compatibility-window.md` names two signals for path (a) and
   * counted only one as delivered: *"paths (b) and (c) emit nothing yet, and
   * neither does the `alia.deprecation` stream event for any path."* This is
   * that event.
   *
   * The replacement is the interesting field. It must be the routing profile
   * the migration map publishes — a caller acts on it — and it must never be a
   * model identity, because ADR 0003 classifies all thirteen as profiles.
   */
  it('names the profile the migration map publishes, for every one of the thirteen', () => {
    const published = new Map<string, string>();
    for (const entry of MIGRATION_MAP.aliases) published.set(entry.alias, entry.becomes.id);
    // Vacuity floor: an unparsed map agrees with everything.
    expect(published.size).toBe(DEPRECATED_ALIASES.length);

    for (const alias of DEPRECATED_ALIASES) {
      const event = aliasDeprecationEvent(alias, null);
      expect(event, alias).not.toBeNull();
      expect(event?.identifier).toBe(alias);
      expect(event?.replacement).toBe(published.get(alias));
      // A profile id, never a model identity in `<publisher>/<model>` form.
      expect(event?.replacement.startsWith('profile:')).toBe(true);
      expect(event?.replacement).not.toContain('/');
    }
  });

  it('follows the alia.* SSE convention and the deprecation date the headers use', () => {
    const event = aliasDeprecationEvent('alia-v1', null);
    expect(event?.eventVersion).toBe(CHAT_EVENT_VERSION);
    expect(event?.deprecatedAt).toBe(ALIAS_DEPRECATION.toISOString());
    expect(event?.documentation).toContain('compatibility-window');
  });

  it('withholds a sunset date exactly as the header does, and carries one when set', () => {
    // Both branches, because a test that only ever sees `null` proves nothing
    // about the branch that ships the day a removal date is agreed.
    expect(aliasDeprecationEvent('alia-v1', ALIAS_SUNSET)?.sunsetAt).toBeNull();
    const removal = new Date('2033-12-31T23:59:59.000Z');
    expect(aliasDeprecationEvent('alia-v1', removal)?.sunsetAt).toBe('2033-12-31T23:59:59.000Z');
  });

  it('says nothing about an identifier that is not deprecated', () => {
    // The negative control. Without it, a builder that returned an event for
    // everything would pass every case above.
    expect(aliasDeprecationEvent('gpt-4o', null)).toBeNull();
    expect(aliasDeprecationEvent('', null)).toBeNull();
    expect(aliasDeprecationEvent('alia-flash', null)).toBeNull();
    expect(aliasDeprecationEvent('mode:fast', null)).toBeNull();
  });
});

describe('the signal survives the real request pipeline, in the order index.ts mounts it', () => {
  /**
   * A middleware can be correct and inert at once, and here the mechanism is
   * MOUNT ORDER: it reads `body.model`, so mounted above `express.json()` it
   * sees `undefined` on every request and the signal silently disappears. No
   * error, no failing route, nothing in a log. A mount order is not something a
   * type can hold, so it gets a test — the same reason
   * `crowdsource-webhook-mount.test.ts` exists.
   */
  async function listenOn(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
    const server: Server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    };
  }

  async function post(app: Express): Promise<Headers> {
    const harness = await listenOn(app);
    try {
      const res = await fetch(`${harness.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'alia-v1', messages: [] }),
      });
      return res.headers;
    } finally {
      await harness.close();
    }
  }

  it('arrives on a real response when mounted below the body parser', async () => {
    const app = express();
    app.use(express.json());
    app.use(aliasDeprecationHeaders);
    app.post('/v1/chat/completions', (_req, res) => {
      res.json({ ok: true });
    });

    const headers = await post(app);
    expect(headers.get('deprecation')).toBe(toStructuredFieldDate(ALIAS_DEPRECATION));
    expect(headers.get('link')).toMatch(/rel="deprecation"/);
    expect(headers.get('sunset')).toBeNull();
  });

  it('disappears when mounted ABOVE the body parser, which is why the order is asserted', async () => {
    // The negative control for the assertion below. If this passed anyway, the
    // ordering check would be measuring nothing.
    const app = express();
    app.use(aliasDeprecationHeaders);
    app.use(express.json());
    app.post('/v1/chat/completions', (_req, res) => {
      res.json({ ok: true });
    });

    const headers = await post(app);
    expect(headers.get('deprecation')).toBeNull();
  });

  it('src/index.ts mounts it below the body parsers and above every router', () => {
    // Reading the ENTRYPOINT, not a fixture of it. Comments are trivia to the
    // parser, so a commented-out mount cannot satisfy this.
    const file = fileURLToPath(new URL('../../index.ts', import.meta.url));
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

    const order: string[] = [];
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.expression.getText(ast) === 'app' &&
        n.expression.name.text === 'use'
      ) {
        for (const arg of n.arguments) {
          if (ts.isIdentifier(arg)) order.push(arg.text);
          else if (ts.isStringLiteralLike(arg)) order.push(`mount:${arg.text}`);
          else if (ts.isCallExpression(arg)) order.push(arg.expression.getText(ast));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(ast);

    // Positive control plus floor: the scan read a real mount list, so a
    // `-1` below means "wrong order" rather than "found nothing".
    expect(order.length).toBeGreaterThanOrEqual(20);
    for (const required of ['express.json', 'express.urlencoded', 'aliasDeprecationHeaders', 'v1Router', 'chatRouter']) {
      expect(order).toContain(required);
    }

    const at = (name: string) => {
      const index = order.indexOf(name);
      // A missing name would otherwise be -1, which satisfies every
      // `toBeLessThan` below and reads as a correct order.
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };

    // Below the body parsers: the middleware reads `body.model`, so above them
    // it sees `undefined` on every request — the failure the round-trip test
    // above reproduces.
    expect(at('express.json')).toBeLessThan(at('aliasDeprecationHeaders'));
    expect(at('express.urlencoded')).toBeLessThan(at('aliasDeprecationHeaders'));

    // Above the ROUTERS that serve model-naming requests — matched on the router
    // identifiers, not on `'/v1'`, because that path string is also used by the
    // CORS and buffering preambles near the top of the file and matching those
    // would assert the wrong thing in the wrong direction.
    expect(at('aliasDeprecationHeaders')).toBeLessThan(at('v1Router'));
    expect(at('aliasDeprecationHeaders')).toBeLessThan(at('chatRouter'));
  });
});
