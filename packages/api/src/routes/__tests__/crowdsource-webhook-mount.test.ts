import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('../../lib/observability/index.js', () => ({ recordMetric: vi.fn() }));

const recordDecisionEvent = vi.fn(async (_input: unknown) => undefined);
const recordIgnoredEvent = vi.fn(async (_input: unknown) => undefined);
vi.mock('../../lib/crowdsource/inbound-service.js', () => ({
  recordDecisionEvent: (input: unknown) => recordDecisionEvent(input),
  recordIgnoredEvent: (input: unknown) => recordIgnoredEvent(input),
}));

/**
 * An in-memory dedupe store.
 *
 * The Mongo-backed one is the production store; here the point is the TRANSPORT —
 * whether the receiver reads the bytes that arrived — so the store is replaced
 * rather than mocked field by field.
 */
const claimed = new Set<string>();
vi.mock('../../lib/crowdsource/event-store.js', () => ({
  processedEventStore: () => ({
    claim: async (eventId: string) => {
      if (claimed.has(eventId)) return false;
      claimed.add(eventId);
      return true;
    },
    release: async (eventId: string) => {
      claimed.delete(eventId);
    },
  }),
}));

import { caseDecidedEventFixture, signWebhookDelivery } from '@oxyhq/crowdsource-testing';
import { resetCrowdSourceConfig } from '../../lib/crowdsource/config.js';
import { assertRawBody, createCrowdSourceWebhookRoutes } from '../crowdsource-webhook.js';

const SECRET = 'whsec_test_secret_value_for_alia';

interface Harness {
  url: string;
  close: () => Promise<void>;
}

async function listen(app: Express): Promise<Harness> {
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** The production mount: the receiver sits ABOVE any body parser. */
function correctlyMountedApp(): Express {
  const app = express();
  app.use('/webhooks', createCrowdSourceWebhookRoutes());
  app.use(express.json());
  return app;
}

/**
 * The regression this whole guard exists for: a parser ran first.
 *
 * Note the `verify` hook — this is Alia's real `express.json()` configuration,
 * which leaves a Buffer on `req.rawBody` for the provider HMAC. The SDK middleware
 * ACCEPTS that Buffer, so without `assertRawBody` this mount order would appear to
 * work while the signature was being checked against bytes the parser handed back
 * rather than the bytes that arrived. That is why the mount order needs a test and
 * not a comment.
 */
function wronglyMountedApp(): Express {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    }),
  );
  app.use('/webhooks', createCrowdSourceWebhookRoutes());
  return app;
}

/**
 * A real signed delivery.
 *
 * The simulator returns the exact bytes it signed, and those are what gets sent —
 * re-serialising the event here would produce a different body than the signature
 * covers and turn every one of these into an accidental tamper test.
 */
function signedDelivery(secret = SECRET) {
  return signWebhookDelivery({ secret, event: caseDecidedEventFixture() });
}

describe('CrowdSource webhook mount order', () => {
  let harness: Harness | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    claimed.clear();
    process.env.CROWDSOURCE_ENABLED = 'true';
    process.env.CROWDSOURCE_SERVICE_KEY = 'app_1:cred_1:secret';
    process.env.CROWDSOURCE_WEBHOOK_SECRET = SECRET;
    resetCrowdSourceConfig();
  });

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    delete process.env.CROWDSOURCE_ENABLED;
    delete process.env.CROWDSOURCE_SERVICE_KEY;
    delete process.env.CROWDSOURCE_WEBHOOK_SECRET;
    resetCrowdSourceConfig();
  });

  it('accepts a correctly signed delivery when mounted above the parser', async () => {
    harness = await listen(correctlyMountedApp());
    const delivery = signedDelivery();

    const response = await fetch(`${harness.url}/webhooks/crowdsource`, {
      method: 'POST',
      headers: delivery.headers,
      body: delivery.body,
    });

    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    expect(recordDecisionEvent).toHaveBeenCalledTimes(1);
  });

  /**
   * The assertion the invariant asks for, stated the way the route sees it: inside
   * the handler, `req.body` must not exist yet.
   */
  it('sees an unparsed request body when mounted above the parser', async () => {
    let observedBodyType = 'never ran';
    const app = express();
    const router = express.Router();
    router.post('/crowdsource', (req, res) => {
      observedBodyType = typeof req.body;
      res.status(204).end();
    });
    app.use('/webhooks', router);
    app.use(express.json());
    harness = await listen(app);

    await fetch(`${harness.url}/webhooks/crowdsource`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });

    expect(observedBodyType).toBe('undefined');
  });

  /**
   * Mutation evidence in permanent form. If somebody moves the mount below
   * `express.json()`, this is the test that fails — and it fails with a refusal
   * rather than with a signature mismatch, so the diagnosis is in the failure.
   */
  it('REFUSES to verify anything when mounted below the parser', async () => {
    harness = await listen(wronglyMountedApp());
    const delivery = signedDelivery();

    const response = await fetch(`${harness.url}/webhooks/crowdsource`, {
      method: 'POST',
      headers: delivery.headers,
      body: delivery.body,
    });

    expect(response.status).toBe(500);
    // The signature was valid. It is the mount that is wrong, and the receiver
    // must not quietly succeed by reconstructing the bytes.
    expect(recordDecisionEvent).not.toHaveBeenCalled();
  });

  it('names the misconfiguration without leaking anything about the delivery', async () => {
    harness = await listen(wronglyMountedApp());
    const delivery = signedDelivery();
    const response = await fetch(`${harness.url}/webhooks/crowdsource`, {
      method: 'POST',
      headers: delivery.headers,
      body: delivery.body,
    });

    const payload: unknown = await response.json();
    expect(JSON.stringify(payload)).toContain('misconfigured');
    expect(JSON.stringify(payload)).not.toContain('signature');
  });

  describe('assertRawBody in isolation', () => {
    function run(body: unknown): { statusCode: number | undefined; passedThrough: boolean } {
      let statusCode: number | undefined;
      let passedThrough = false;
      const res = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json() {
          return this;
        },
      };
      assertRawBody(
        { body } as express.Request,
        res as unknown as express.Response,
        () => {
          passedThrough = true;
        },
      );
      return { statusCode, passedThrough };
    }

    it('passes through only when the body is untouched', () => {
      expect(run(undefined)).toEqual({ statusCode: undefined, passedThrough: true });
    });

    /**
     * A Buffer means `express.raw()` ran. That is not the mount this route wants
     * either — it reads the stream itself, and accepting a Buffer here would make
     * the guard depend on somebody else's parser staying configured as it is today.
     */
    it('refuses a parsed object, an empty object and a Buffer alike', () => {
      for (const body of [{ a: 1 }, {}, Buffer.from('{}'), '', 'text']) {
        const outcome = run(body);
        expect(outcome.passedThrough).toBe(false);
        expect(outcome.statusCode).toBe(500);
      }
    });
  });
});

describe('CrowdSource webhook route without a secret', () => {
  beforeEach(() => {
    delete process.env.CROWDSOURCE_ENABLED;
    delete process.env.CROWDSOURCE_WEBHOOK_SECRET;
    resetCrowdSourceConfig();
  });

  afterEach(() => resetCrowdSourceConfig());

  /**
   * Not mounted, rather than mounted and permissive. A route that answers anything
   * at all without a secret is a route that will one day be reasoned about as if it
   * verified something.
   */
  it('404s, indistinguishably from not having the feature', async () => {
    const app = express();
    app.use('/webhooks', createCrowdSourceWebhookRoutes());
    const harness = await listen(app);
    try {
      const response = await fetch(`${harness.url}/webhooks/crowdsource`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(404);
    } finally {
      await harness.close();
    }
  });
});
