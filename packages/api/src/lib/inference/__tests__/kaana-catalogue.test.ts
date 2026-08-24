import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Asking Kaana what it serves.
 *
 * The failures worth catching here are all the same shape: something goes
 * wrong, and the product quietly stops using Kaana for everything rather than
 * for the model it could not confirm. So every case is about the difference
 * between "Kaana does not serve this" and "I could not ask", which are the same
 * value in a naive implementation and must not be here.
 */

import {
  fetchKaanaCatalogue,
  getKaanaCatalogue,
  kaanaReferenceFor,
  KAANA_MODEL_LINE_ALIASES,
  resetKaanaCatalogue,
} from '../kaana-catalogue.js';

const { privateKey } = await import('node:crypto').then((c) => c.generateKeyPairSync('ed25519'));
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const ENV: NodeJS.ProcessEnv = {
  KAANA_EDGE_KEY_ID: 'alia-edge-test',
  KAANA_EDGE_SIGNING_PRIVATE_KEY: PEM,
  RELAY_BASE_URL: 'https://relay.oxy.so',
  ALIA_RELAY_ACCOUNT_ID: 'acc_test',
  ALIA_RELAY_APPLICATION_ID: 'app_alia',
  ALIA_RELAY_CREDENTIAL_ID: 'cred_test',
  ALIA_RELAY_ENVIRONMENT: 'production',
  ALIA_RELAY_INFERENCE_SCOPES: 'inference:invoke',
};

const BODY = {
  // Where Kaana actually puts it. The reader looked at the top level and got
  // the empty string on every real response, which no test noticed because
  // every fixture put it where the reader was looking.
  configuration: { snapshotId: 'snap_test', ageSeconds: 12, maxAgeSeconds: 3600 },
  servesUnpinned: true,
  models: [
    { model: 'anthropic/claude-sonnet-4', modelReference: 'anthropic/claude-sonnet-4@r1', providers: ['openrouter'] },
    { model: 'openai/gpt-oss-120b', modelReference: 'openai/gpt-oss-120b@r1', providers: ['groq', 'openrouter'] },
  ],
};

function answerWith(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetKaanaCatalogue();
});

describe('fetching it', () => {
  it('signs the request with the edge key, over the empty body a GET carries', async () => {
    answerWith(200, BODY);
    await fetchKaanaCatalogue(ENV);

    const call = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(call[0]).toBe('https://relay.oxy.so/internal/v1/models');
    const headers = call[1].headers as Record<string, string>;
    expect(headers['X-Oxy-Relay-Key-Id']).toBe('alia-edge-test');
    expect(headers['X-Oxy-Relay-Signature']).toMatch(/^v1=/);
  });

  it('reads the models and whether unpinned names resolve at all', async () => {
    answerWith(200, BODY);
    const catalogue = await fetchKaanaCatalogue(ENV);
    expect(catalogue?.servesUnpinned).toBe(true);
    // Measured against production: read from the top level this was '' on every
    // real response.
    expect(catalogue?.snapshotId).toBe('snap_test');
    expect(catalogue?.models.map((m) => m.model)).toEqual([
      'anthropic/claude-sonnet-4',
      'openai/gpt-oss-120b',
    ]);
  });

  it('answers null, never an empty catalogue, when it cannot ask', async () => {
    // An empty catalogue means "Kaana serves nothing", and a caller acting on
    // that routes EVERYTHING away from Kaana over one bad response.
    answerWith(404, {});
    expect(await fetchKaanaCatalogue(ENV)).toBeNull();

    answerWith(200, { servesUnpinned: true, models: [{ model: 42 }] });
    expect(await fetchKaanaCatalogue(ENV)).toBeNull();

    expect(await fetchKaanaCatalogue({ ...ENV, KAANA_EDGE_KEY_ID: '' })).toBeNull();
  });
});

describe('what it does with the answer', () => {
  it('returns the name it confirmed, for a line the catalogue actually names', async () => {
    answerWith(200, BODY);
    expect(await kaanaReferenceFor('openai/gpt-oss-120b', ENV)).toBe('openai/gpt-oss-120b');
    // The negative control that matters: a name Kaana does not serve must not
    // be routed to it, and a NEAR MISS is the realistic case.
    expect(await kaanaReferenceFor('openai/gpt-oss-120', ENV)).toBeNull();
  });

  it('sends Kaana its own spelling, not the one Alia publishes', async () => {
    // `publisher` is a name customers pin (ADR 0003), so Alia keeps `xai/` and
    // translates here. Answering `true` to "do you serve xai/grok-4.6" and then
    // sending that spelling is asking one question and acting on another.
    answerWith(200, { ...BODY, models: [...BODY.models, { model: 'x-ai/grok-4.6', modelReference: 'x-ai/grok-4.6@r1', providers: ['openrouter'] }] });
    expect(await kaanaReferenceFor('xai/grok-4.6', ENV)).toBe('x-ai/grok-4.6');
  });

  it('does not invent a translation for a name Kaana still lacks', async () => {
    // A translated name that the catalogue does not carry is not served, and
    // must not be routed to on the strength of the map alone.
    answerWith(200, BODY);
    expect(await kaanaReferenceFor('xai/grok-4.6', ENV)).toBeNull();
  });

  it('refuses everything while the snapshot is too stale to resolve a name', async () => {
    // Every entry would be refused one request at a time. Reading the list
    // without reading this is how a catalogue of names that all fail is built.
    answerWith(200, { ...BODY, servesUnpinned: false });
    expect(await kaanaReferenceFor('openai/gpt-oss-120b', ENV)).toBeNull();
  });

  it('holds only names that actually differ', async () => {
    // An entry mapping a name to itself is a translation that does nothing, and
    // would sit in the map looking like coverage.
    for (const [alia, kaana] of Object.entries(KAANA_MODEL_LINE_ALIASES)) {
      expect(kaana, alia).not.toBe(alia);
      expect(alia).toMatch(/^[^/]+\/[^/]+$/);
      expect(kaana).toMatch(/^[^/]+\/[^/]+$/);
    }
    expect(Object.keys(KAANA_MODEL_LINE_ALIASES).length).toBeGreaterThan(0);
  });

  it('holds an answer rather than asking per request', async () => {
    answerWith(200, BODY);
    await getKaanaCatalogue(ENV);
    await getKaanaCatalogue(ENV);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it('does not hold a FAILURE for as long as it holds an answer', async () => {
    // Caching "I could not ask" for the full term turns one bad response into
    // minutes of routing everything away from Kaana.
    answerWith(500, {});
    expect(await getKaanaCatalogue(ENV)).toBeNull();

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(31_000);
      answerWith(200, BODY);
      expect(await getKaanaCatalogue(ENV)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the translation map is not a prototype lookup', () => {
  it('does not answer a key it inherited', async () => {
    // `KAANA_MODEL_LINE['constructor']` is the Object constructor: a value, so
    // a `??` fallback never fires and a FUNCTION would be sent onward as the
    // model name. The read is guarded, so this resolves like any other name
    // Kaana does not serve.
    answerWith(200, BODY);
    for (const inherited of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(await kaanaReferenceFor(inherited, ENV), inherited).toBeNull();
    }
  });
});
