/**
 * Who may call this host: a workload whose AWS role is on the allow-list,
 * proven the way Oxy ADR 0026 proves it, and nothing else.
 *
 * ## No shared secret, and no new client code
 *
 * The host serves the SAME two routes Oxy serves for workload service tokens —
 * `POST /auth/service-token/workload/challenge` and
 * `POST /auth/service-token/workload` — with the same bodies. So the Alia API
 * calls `requestWorkloadServiceToken({ baseUrl: <this host> })` from
 * `@oxy.so/core/server`, already in its dependency tree, and signs nothing of
 * its own. What it sends is a SigV4-signed `GetCallerIdentity` request it never
 * sent to AWS; this host replays it to STS and believes AWS's answer about who
 * signed it, never the caller's.
 *
 * The verifier below is a port of Oxy's (`OxyHQServices/packages/api/src/
 * services/workloadAttestation.service.ts`) and keeps its two safety rules:
 *
 *  - the replayed request is pinned to an exact STS host and an exact body —
 *    only the caller's HEADERS are used, so a payload cannot make this host
 *    fetch anything else;
 *  - the nonce must be inside the SIGNED headers and must be one this host
 *    issued in the last five minutes, used once. A nonce Oxy issued is not one
 *    of ours, so an attestation captured on its way to Oxy is useless here and
 *    the other way round.
 *
 * ## The token
 *
 * A verified caller receives an HMAC token valid for fifteen minutes, signed
 * with a key generated at boot and never written anywhere. Restarting the host
 * invalidates every token, and a client that gets a 401 attests again — which
 * is the whole rotation story, and why there is nothing for an operator to
 * provision, copy or rotate.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const ATTESTATION_NONCE_HEADER = 'x-oxy-attestation-nonce';
const STS_BODY = 'Action=GetCallerIdentity&Version=2011-06-15';
const STS_HOST_PATTERN = /^sts(\.[a-z0-9-]+)?\.amazonaws\.com$/;
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const NONCE_TTL_MS = 5 * 60 * 1000;
const MAX_OUTSTANDING_NONCES = 1000;
export const TOKEN_TTL_SECONDS = 15 * 60;

export class AttestationError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'AttestationError';
  }
}

/** `arn:aws:sts::<acct>:assumed-role/<role>/<session>` → `arn:aws:iam::<acct>:role/<role>`. */
export function canonicalAwsSubject(arn: string): string {
  const match = /^arn:(aws[a-z-]*):sts::(\d+):assumed-role\/([^/]+)\/.+$/.exec(arn);
  if (!match) return arn;
  const [, partition, account, roleName] = match;
  return `arn:${partition}:iam::${account}:role/${roleName}`;
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function parseAmzDate(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface WorkloadAuthorityOptions {
  allowedRoleArns: readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
  /** Injected in tests; generated at boot otherwise. */
  key?: Buffer;
}

export class WorkloadAuthority {
  private readonly nonces = new Map<string, number>();
  private readonly key: Buffer;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: WorkloadAuthorityOptions) {
    this.key = options.key ?? randomBytes(32);
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  issueNonce(): string {
    const now = this.now();
    for (const [nonce, expires] of this.nonces) if (expires <= now) this.nonces.delete(nonce);
    if (this.nonces.size >= MAX_OUTSTANDING_NONCES) {
      throw new AttestationError('too_many_challenges', 'Too many outstanding challenges; try again shortly.');
    }
    const nonce = randomBytes(24).toString('base64url');
    this.nonces.set(nonce, now + NONCE_TTL_MS);
    return nonce;
  }

  /** Consume a nonce: valid once, and only if this host issued it recently. */
  private consumeNonce(nonce: string): boolean {
    const expires = this.nonces.get(nonce);
    this.nonces.delete(nonce);
    return expires !== undefined && expires > this.now();
  }

  /**
   * Verify `{ provider, nonce, attestation: { headers } }` and mint a token for
   * an allow-listed role. Every refusal is an {@link AttestationError} with a
   * bounded `reason`; nothing the caller sent is echoed.
   */
  async exchange(body: unknown): Promise<{ token: string; expiresIn: number; appName: string }> {
    if (typeof body !== 'object' || body === null) throw new AttestationError('malformed', 'The request is not an object.');
    const { provider, nonce, attestation } = body as { provider?: unknown; nonce?: unknown; attestation?: unknown };
    if (provider !== 'aws-iam') throw new AttestationError('unsupported_provider', 'Only aws-iam attestations are accepted.');
    if (typeof nonce !== 'string' || !this.consumeNonce(nonce)) {
      throw new AttestationError('unknown_challenge', 'The challenge is unknown, used or expired.');
    }
    const headers = this.parse(attestation);

    const host = headerOf(headers, 'host');
    if (!host || !STS_HOST_PATTERN.test(host)) throw new AttestationError('host_not_sts', 'The attestation is not addressed to AWS STS.');
    const authorization = headerOf(headers, 'authorization');
    if (!authorization?.startsWith('AWS4-HMAC-SHA256 ')) throw new AttestationError('unsigned', 'The attestation carries no SigV4 signature.');
    const signedHeaders = /SignedHeaders=([^,]+)/.exec(authorization)?.[1] ?? '';
    if (!signedHeaders.split(';').includes(ATTESTATION_NONCE_HEADER)) {
      throw new AttestationError('nonce_unsigned', 'The attestation does not sign the nonce header.');
    }
    const signedNonce = headerOf(headers, ATTESTATION_NONCE_HEADER);
    if (!signedNonce || !safeEquals(signedNonce, nonce)) {
      throw new AttestationError('nonce_mismatch', 'The attestation answers a different challenge.');
    }
    const signedAt = parseAmzDate(headerOf(headers, 'x-amz-date'));
    if (signedAt === null || Math.abs(this.now() - signedAt) > MAX_SIGNATURE_AGE_MS) {
      throw new AttestationError('stale', 'The attestation was signed too long ago.');
    }

    const subject = canonicalAwsSubject(await this.callSts(host, headers));
    if (!this.options.allowedRoleArns.includes(subject)) {
      throw new AttestationError('not_allowed', 'This workload may not use the computer host.');
    }
    return { token: this.mint(subject), expiresIn: TOKEN_TTL_SECONDS, appName: 'alia' };
  }

  private parse(attestation: unknown): Record<string, string> {
    const headers = (attestation as { headers?: unknown } | null)?.headers;
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
      throw new AttestationError('malformed', 'The attestation carries no headers.');
    }
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value !== 'string') throw new AttestationError('malformed', 'An attestation header is not a string.');
      flat[key] = value;
    }
    return flat;
  }

  private async callSts(host: string, headers: Record<string, string>): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`https://${host}/`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: STS_BODY,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AttestationError('sts_unreachable', 'The attestation could not be verified right now.');
    }
    const text = await response.text();
    if (!response.ok) throw new AttestationError('sts_rejected', 'The attestation was refused by AWS.');
    const arn = /<Arn>([^<]+)<\/Arn>/.exec(text)?.[1];
    if (!arn) throw new AttestationError('sts_unreadable', 'AWS did not name the caller.');
    return arn;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  mint(subject: string): string {
    const payload = Buffer.from(
      JSON.stringify({ sub: subject, exp: Math.floor(this.now() / 1000) + TOKEN_TTL_SECONDS }),
    ).toString('base64url');
    return `v1.${payload}.${this.sign(payload)}`;
  }

  /** The caller's canonical role, or `null`. Re-checks the allow-list on every call. */
  verifyToken(token: string | undefined): string | null {
    if (!token) return null;
    const [version, payload, signature] = token.split('.');
    if (version !== 'v1' || !payload || !signature || !safeEquals(signature, this.sign(payload))) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown; exp?: unknown };
      if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
      if (claims.exp * 1000 <= this.now()) return null;
      return this.options.allowedRoleArns.includes(claims.sub) ? claims.sub : null;
    } catch {
      return null;
    }
  }
}
