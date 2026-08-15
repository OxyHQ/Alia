/**
 * The behavioural half of gate 4's logging checks (#139 workstream 15).
 *
 * `__tests__/architectureGates.test.ts` asserts the SHAPE — that every provider
 * response body is read through one function and that the logger is wired to
 * scrub. That is a census over source, and a census cannot tell you what pino
 * actually emits. This drives real errors through the real code and reads the
 * bytes the logger writes.
 *
 * ## Why it lives inside `internal/providers/`
 *
 * Gate 1 freezes the (importer → provider tree) pairs by exact count, so a test
 * importing an adapter from `lib/__tests__/` would have to widen that list. A
 * test is a bad reason to widen a migration inventory, and a file inside the
 * tree is skipped by that census for the same reason the adapters are.
 *
 * ## The trap this file is written against
 *
 * A redaction test that builds the object it then redacts is testing its own
 * fixture. So every assertion here has a POSITIVE CONTROL in the same currency:
 * before asserting that the credential is absent from the output, it asserts
 * the credential is present in the INPUT the system was handed — the stubbed
 * upstream body, or the `responseBody` the AI SDK itself parsed. Delete the
 * redaction and every one of these goes red, because the input control keeps
 * passing while the output assertion fails. Mutation-tested in both places.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';

import rootLogger, { log } from '../../../../lib/logger.js';
import { redactProviderText } from '../provider-error-body.js';
import { openaiProvider } from '../providers/openai.js';
import type { KeyConfig } from '../types';

/**
 * Synthetic, and assembled from fragments so that no line of this file is
 * itself a plausible credential and no scanner — ours or GitHub's — can mistake
 * it for one. It has the SHAPE the patterns match (a project-key prefix, then
 * 48 characters) and none of the entropy: a single repeated letter and a
 * recognisable tail. Nothing accepts it, and there is nothing to rotate.
 */
const KEY_TAIL = 'ENDS0042';
const SYNTHETIC_KEY = ['sk', 'proj', 'A'.repeat(40) + KEY_TAIL].join('-');

/**
 * A credential with NO vendor prefix, which is what Mistral, Cohere, Together,
 * SambaNova, Hyperbolic, Novita and Cloudflare issue. No pattern can match it,
 * so it is the case that proves the exact-credential pass does real work.
 */
const PREFIXLESS_KEY = 'q7' + 'w'.repeat(28) + 'z3';

/** The body an OpenAI-compatible provider returns for a rejected credential. */
function unauthorizedBody(credential: string): string {
  return JSON.stringify({
    error: {
      message: `Incorrect API key provided: ${credential}. You can find your API key in your account settings.`,
      type: 'invalid_request_error',
      param: null,
      code: 'invalid_api_key',
    },
  });
}

const keyConfig: KeyConfig = {
  keyId: 'key-under-test',
  key: SYNTHETIC_KEY,
  provider: 'openai',
  modelId: 'test-model',
};

describe('the chokepoint redacts every shape a credential arrives in', () => {
  const shapes: readonly [string, string][] = [
    ['bare in a JSON error object', unauthorizedBody(SYNTHETIC_KEY)],
    ['inside a URL query string', `upstream rejected https://example.invalid/v1/models?key=${SYNTHETIC_KEY}&alt=sse`],
    ['truncated to a dozen characters', `Incorrect API key provided: ${SYNTHETIC_KEY.slice(0, 12)}...`],
    ['URL-encoded', `redirect_uri=x&api_key=${encodeURIComponent(SYNTHETIC_KEY)}`],
    ['twice in one body', `${SYNTHETIC_KEY} rejected; retry sent ${SYNTHETIC_KEY}`],
  ];

  for (const [shape, body] of shapes) {
    it(`removes a credential ${shape}`, () => {
      // The control: the input really does carry the credential, so a passing
      // assertion below cannot mean "there was nothing to find".
      expect(body).toContain(SYNTHETIC_KEY.slice(0, 12));

      const redacted = redactProviderText(body, SYNTHETIC_KEY);
      expect(redacted).not.toContain(SYNTHETIC_KEY);
      expect(redacted).not.toContain(SYNTHETIC_KEY.slice(0, 12));
    });
  }

  it('removes a MASKED echo, tail included', () => {
    // OpenAI's real 401 quotes the key as prefix + asterisks + its last four
    // characters. The tail is the disclosure, and no prefix pattern reaches it.
    const masked = `sk-p${'*'.repeat(28)}${KEY_TAIL.slice(-4)}`;
    const body = unauthorizedBody(masked);
    expect(body).toContain(KEY_TAIL.slice(-4));

    expect(redactProviderText(body, SYNTHETIC_KEY)).not.toContain(KEY_TAIL.slice(-4));
  });

  it('removes a credential no pattern can recognise, because it matches the VALUE', () => {
    const body = unauthorizedBody(PREFIXLESS_KEY);

    // The control that makes this test mean something: the pattern pass alone
    // is blind to this credential. If this ever starts failing, the exact pass
    // is no longer the thing being measured here.
    expect(redactProviderText(body, 'unrelated-credential-value')).toContain(PREFIXLESS_KEY);

    expect(redactProviderText(body, PREFIXLESS_KEY)).not.toContain(PREFIXLESS_KEY);
  });

  it('keeps the text that makes a failure diagnosable', () => {
    const redacted = redactProviderText(unauthorizedBody(SYNTHETIC_KEY), SYNTHETIC_KEY);
    expect(redacted).toContain('Incorrect API key provided');
    expect(redacted).toContain('invalid_api_key');
  });

  it('leaves a body with no credential in it byte-identical', () => {
    // The negative control. A redactor that mangles everything would pass every
    // assertion above and be useless.
    const body = JSON.stringify({ error: { message: 'The model is overloaded', code: 'overloaded' } });
    expect(redactProviderText(body, SYNTHETIC_KEY)).toBe(body);
  });

  it('bounds an unbounded body', () => {
    const flood = 'x'.repeat(50_000);
    expect(redactProviderText(flood, SYNTHETIC_KEY).length).toBeLessThan(1_100);
  });
});

describe('a real 401 driven through a real adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws an error whose message carries the status and not the credential', async () => {
    const body = unauthorizedBody(SYNTHETIC_KEY);
    // The network is the only thing replaced: the adapter runs for real and is
    // handed a real `Response`, which it reads with a real `.text()`.
    expect(body).toContain(SYNTHETIC_KEY);
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(body, { status: 401 })));

    const thrown = await openaiProvider
      .proxy(keyConfig, [{ role: 'user', content: 'hello' }])
      .then(() => null, (err: unknown) => err);

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('401');
    expect(message).toContain('Incorrect API key provided');
    expect(message).not.toContain(SYNTHETIC_KEY);
    expect(message).not.toContain(SYNTHETIC_KEY.slice(0, 12));
  });
});

describe('what the logger actually writes', () => {
  let server: Server;
  let baseURL: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(unauthorizedBody(SYNTHETIC_KEY));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  /**
   * Swap the sink under the REAL logger — same config, same serializers, same
   * redaction — and hand back what it wrote. `Object.defineProperty` rather
   * than a cast: `streamSym` is public API on pino's own export.
   *
   * The descriptor is read back before anything is written, and the caller
   * asserts on the line COUNT, because a swap that silently failed to take
   * would capture nothing and every "the credential is absent" assertion below
   * would pass on an empty string.
   */
  function captureLogOutput(emit: () => void): string[] {
    const { streamSym } = pino.symbols;
    const original = Object.getOwnPropertyDescriptor(rootLogger, streamSym);
    expect(original).toBeDefined();

    const lines: string[] = [];
    Object.defineProperty(rootLogger, streamSym, {
      value: { write: (line: string) => lines.push(line) },
      writable: true,
      configurable: true,
    });
    try {
      emit();
    } finally {
      if (original) Object.defineProperty(rootLogger, streamSym, original);
    }
    return lines;
  }

  it('emits an AI SDK provider error with the upstream body scrubbed', async () => {
    const openai = createOpenAI({ apiKey: SYNTHETIC_KEY, baseURL });

    const thrown = await generateText({
      model: openai.chat('test-model'),
      prompt: 'hello',
      maxRetries: 0,
    }).then(() => null, (err: unknown) => err);

    // Two controls before the measurement:
    //
    //  1. The error is the SDK's own, not one this file built — nothing here
    //     constructed `responseBody`; the SDK parsed it off the wire.
    //  2. It carries the credential. This is what would be logged with the
    //     serializer removed, and it is why this test cannot pass vacuously.
    const responseBody = (thrown as { responseBody?: string }).responseBody;
    expect(responseBody).toContain(SYNTHETIC_KEY);

    const lines = captureLogOutput(() => {
      log.keys.error({ err: thrown, provider: 'openai', modelId: 'test-model' }, 'Provider failed');
    });

    // The vacuity floor: the swap took, and exactly one line was written.
    expect(lines).toHaveLength(1);
    const line = lines[0];

    expect(line).toContain('Provider failed');
    expect(line).not.toContain(SYNTHETIC_KEY);
    expect(line).not.toContain(SYNTHETIC_KEY.slice(0, 12));
    // Diagnosis survives: the status and the provider's own error code are
    // still there. A serializer that blanked the error would pass the two
    // assertions above and be worthless.
    expect(line).toContain('401');
    expect(line).toContain('invalid_api_key');
  });

  it('scrubs a credential hung off a custom property, which redact.paths cannot reach', () => {
    // The `provider-api.ts` shape: `providerMessage` is not a path pino knows,
    // and pino's error serializer copies every enumerable property.
    const err: Error & { providerMessage?: string; reason?: string } = new Error(
      'Provider API exhausted: test-model (auth)',
    );
    err.providerMessage = unauthorizedBody(SYNTHETIC_KEY);
    err.reason = 'auth';
    expect(err.providerMessage).toContain(SYNTHETIC_KEY);

    const lines = captureLogOutput(() => log.keys.error({ err }, 'Provider API exhausted'));

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(SYNTHETIC_KEY);
    expect(lines[0]).toContain('"reason":"auth"');
  });

  it('scrubs a credential in a nested object and in a cause chain', () => {
    const cause = new Error(`upstream said: ${SYNTHETIC_KEY}`);
    const err: Error & { data?: { error?: { message?: string } } } = new Error('wrapped', { cause });
    err.data = { error: { message: `Incorrect API key provided: ${SYNTHETIC_KEY}` } };

    const lines = captureLogOutput(() => log.keys.error({ err }, 'nested'));

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(SYNTHETIC_KEY);
    // The control for THIS test: the nested structure really was serialized, so
    // the absence above is redaction and not a serializer that dropped `data`.
    expect(lines[0]).toContain('Incorrect API key provided');
    expect(lines[0]).toContain('upstream said');
  });

  it('terminates on a cyclic error property rather than recursing forever', () => {
    // A scrub that walks an error's own properties has to survive a structure
    // pino itself survives. `data` pointing back at itself is legal, and the
    // depth bound is the only thing that ends the walk.
    const cyclic: Record<string, unknown> = { message: `upstream said: ${SYNTHETIC_KEY}` };
    cyclic.self = cyclic;
    const err: Error & { data?: unknown } = new Error('cyclic');
    err.data = cyclic;

    const lines = captureLogOutput(() => log.keys.error({ err }, 'cyclic'));

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(SYNTHETIC_KEY);
    expect(lines[0]).toContain('upstream said');
  });

  it('still redacts what it always did', () => {
    // The pre-existing behaviour, kept as a control: top-level `token` was
    // already covered by `redact.paths`, and it is the measurement that proves
    // the logger under test is the configured one.
    const lines = captureLogOutput(() => log.keys.error({ token: SYNTHETIC_KEY }, 'control'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[REDACTED]');
    expect(lines[0]).not.toContain(SYNTHETIC_KEY);
  });
});
