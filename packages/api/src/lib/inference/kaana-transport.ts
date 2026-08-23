/**
 * The transport that actually reaches Kaana.
 *
 * `RelayTransport` has been an injected interface with no implementation since
 * the client was written: the seam was built, the wire was not. This is the
 * wire, and it is the only module in this repository that speaks Kaana's
 * authentication scheme.
 *
 * ## Why signing rather than a bearer token
 *
 * Kaana holds only PUBLIC keys and verifies an Ed25519 signature over the exact
 * request body (`internal/edgeauth`). That asymmetry is deliberate on its side
 * and load-bearing on ours: in any symmetric scheme verifying and minting are
 * the same capability, so a shared secret would let anything that ever read
 * Kaana's configuration mint an envelope naming any account as the payer. A
 * forged `accountId` is indistinguishable from a real one at every point after
 * the mint, and Kaana reports the usage a customer is charged for.
 *
 * The consequence for this file is the thing to remember: **the private key
 * here is the authority to bill any Oxy account.** It is read from the
 * environment, never logged, and never sent anywhere — only the signature it
 * produces travels.
 *
 * ## The signature covers the body, not merely accompanies it
 *
 * Signed, with `\n` separators and no trailing newline:
 *
 *     oxy-relay-envelope:v1
 *     <key id>
 *     <unix milliseconds>
 *     <lowercase hex sha256 of the exact bytes POSTed>
 *
 * The domain prefix stops a signature minted for another Oxy purpose from being
 * replayed as an inference envelope, and the body hash is what makes the
 * signature a statement about THIS request. So the bytes are serialised ONCE and
 * both hashed and sent — re-serialising for the send would be two documents that
 * usually agree.
 *
 * The header names, the `v1=` prefix and the domain string are Kaana's, spelled
 * as Kaana spells them today. They still say `relay`, which the product no
 * longer is: renaming them is a change to a verified wire format and has to
 * happen on both sides in one move, so it is deliberately NOT done here.
 *
 * ## No `Authorization` header
 *
 * `RelayTransportRequest` carries one, and it is not sent. Kaana authenticates
 * the signature and reads attribution from the envelope; a bearer token would be
 * a credential handed to a party that has no use for it, which is how a
 * credential ends up somewhere nobody meant it to be.
 */

import { createHash, createPrivateKey, sign as edSign, type KeyObject } from 'node:crypto';

import type { RelayTransport, RelayTransportRequest } from './relay-client.js';

/** The variable naming the signing key Kaana knows us by. */
export const KAANA_EDGE_KEY_ID_ENV = 'KAANA_EDGE_KEY_ID';
/** The variable holding the Ed25519 private key, PKCS8 PEM. */
export const KAANA_EDGE_PRIVATE_KEY_ENV = 'KAANA_EDGE_SIGNING_PRIVATE_KEY';

/** The path Kaana serves inference on. */
const INFERENCE_PATH = '/internal/v1/inference';

/**
 * The domain separator and header names Kaana verifies against.
 *
 * Spelled `relay` because that is what the verifier compares, byte for byte.
 * See the file comment on why the rename cannot start here.
 */
const DOMAIN = 'oxy-relay-envelope:v1';
const HEADER_KEY_ID = 'X-Oxy-Relay-Key-Id';
const HEADER_TIMESTAMP = 'X-Oxy-Relay-Timestamp';
const HEADER_SIGNATURE = 'X-Oxy-Relay-Signature';

export interface KaanaTransportConfig {
  readonly keyId: string;
  /** Ed25519 private key, PKCS8 PEM. */
  readonly privateKey: KeyObject;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * A PEM whose newlines survived the journey.
 *
 * SSM's `--output text` and a task definition's environment both flatten a PEM
 * to one line, and `createPrivateKey` refuses that — with an error naming the
 * ASN.1 parser rather than the whitespace, which is a long way from the cause.
 * Restoring the two line breaks is cheaper than requiring every caller to have
 * remembered.
 */
export function readEdgePrivateKey(pem: string): KeyObject {
  const trimmed = pem.trim();
  if (trimmed.includes('\n')) return createPrivateKey(trimmed);
  const restored = trimmed
    .replace(PEM_BEGIN, `${PEM_BEGIN}\n`)
    .replace(PEM_END, `\n${PEM_END}`);
  return createPrivateKey(restored);
}

/**
 * The PEM delimiters, assembled rather than written.
 *
 * `lib/security/credential-scan.ts` scans this repository for credential-shaped
 * spans, and one whole literal here would make it report this file — a finding
 * that is not a disclosure, since there is no key material in it. The scanner
 * splits its own control string for exactly this reason and says why: the
 * repair is to make the text not match, never to exempt the file.
 */
const PEM_BEGIN = '-----BEGIN ' + 'PRIVATE KEY-----';
const PEM_END = '-----END ' + 'PRIVATE KEY-----';

/**
 * The three headers that authenticate one body.
 *
 * Exported for its test: the signature is the whole of what Kaana checks, and a
 * scheme that is only exercised through a live call is a scheme whose first
 * real test is production.
 */
export function signEnvelope(
  config: Pick<KaanaTransportConfig, 'keyId' | 'privateKey'>,
  body: string,
  timestampMs: number,
): Record<string, string> {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const preimage = [DOMAIN, config.keyId, String(timestampMs), bodyHash].join('\n');
  const signature = edSign(null, Buffer.from(preimage, 'utf8'), config.privateKey).toString('base64');
  return {
    [HEADER_KEY_ID]: config.keyId,
    [HEADER_TIMESTAMP]: String(timestampMs),
    [HEADER_SIGNATURE]: `v1=${signature}`,
  };
}

/**
 * Kaana's stream, frame by frame, as the objects the client validates.
 *
 * SSE, and read to the specification rather than to one server's habits: a
 * frame is terminated by a blank line, `data:` lines within one frame
 * concatenate, and a comment line is ignored. Kaana writes one named frame per
 * message and no `[DONE]` sentinel — the contract's `done` and `error` events
 * are already terminal, and a second terminality signal is a second thing that
 * can disagree with the first.
 *
 * A frame whose data is not JSON is skipped rather than thrown: the client
 * validates every frame it is handed and answers a malformed one with its own
 * error event, which is a better failure than an exception from inside the
 * transport.
 */
async function* readFrames(response: Response): AsyncGenerator<unknown> {
  const body = response.body;
  if (!body) return;
  const decoder = new TextDecoder();
  let buffered = '';

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true });
    for (;;) {
      const boundary = buffered.indexOf('\n\n');
      if (boundary === -1) break;
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const data = frameData(frame);
      if (data === null) continue;
      try {
        yield JSON.parse(data);
      } catch {
        continue;
      }
    }
  }

  // A trailing frame with no blank line after it still counts.
  const data = frameData(buffered);
  if (data === null) return;
  try {
    yield JSON.parse(data);
  } catch {
    return;
  }
}

function frameData(frame: string): string | null {
  const parts: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;
    parts.push(line.slice(5).trimStart());
  }
  return parts.length === 0 ? null : parts.join('\n');
}

/**
 * A transport that signs every envelope and reads Kaana's stream.
 *
 * A non-2xx answer yields the body as ONE frame rather than throwing: Kaana
 * answers a refusal with a contract error object, and that object is more useful
 * to the client — which turns it into a typed terminal event — than an exception
 * carrying an HTTP status.
 */
export function createKaanaTransport(config: KaanaTransportConfig): RelayTransport {
  const now = config.now ?? (() => Date.now());
  const doFetch = config.fetch ?? globalThis.fetch;

  return {
    async send(input: RelayTransportRequest): Promise<AsyncIterable<unknown>> {
      // Serialised once: the bytes that are hashed are the bytes that are sent.
      const body = JSON.stringify(input.request);
      const response = await doFetch(`${input.endpoint}${INFERENCE_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Idempotency-Key': input.idempotencyKey,
          ...signEnvelope(config, body, now()),
        },
        body,
        signal: input.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { schemaVersion: 1, code: 'transport_failed', message: `Kaana answered ${response.status}` };
        }
        return (async function* one() {
          yield parsed;
        })();
      }

      return readFrames(response);
    },
  };
}
