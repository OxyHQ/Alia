/**
 * The workload exchange, with STS replaced by a function that answers like STS.
 *
 * The client side is NOT mocked: `requestWorkloadServiceToken` from
 * `@oxy.so/core/server` — the function the Alia API really calls — signs the
 * attestation here against fake container credentials and talks to the real
 * express app. So a drift between Oxy's protocol and this host's copy of it
 * fails this file.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestWorkloadServiceToken } from '@oxy.so/core/server';
import { WorkloadAuthority, canonicalAwsSubject } from '../attestation.js';
import { ComputerService } from '../computer-service.js';
import { createApp } from '../http.js';
import { MemoryStore } from '../store.js';
import { FakeDocker } from './fake-docker.js';

const ALIA_ROLE = 'arn:aws:iam::237343248947:role/oxy-alia-task';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

function stsAnswering(arn: string | null) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    expect(init?.body).toBe('Action=GetCallerIdentity&Version=2011-06-15');
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    if (arn === null) return new Response('<Error/>', { status: 403 });
    return new Response(`<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>${arn}</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`);
  });
}

describe('canonicalAwsSubject', () => {
  it('reduces a task session to its role, and leaves other ARNs alone', () => {
    expect(canonicalAwsSubject('arn:aws:sts::237343248947:assumed-role/oxy-alia-task/0123abcd')).toBe(ALIA_ROLE);
    expect(canonicalAwsSubject('arn:aws:iam::237343248947:user/oxy-admin')).toBe('arn:aws:iam::237343248947:user/oxy-admin');
  });
});

describe('the workload exchange, end to end', () => {
  let server: ReturnType<ReturnType<typeof createApp>['listen']>;
  let baseUrl: string;
  let sts: ReturnType<typeof stsAnswering>;
  let authority: WorkloadAuthority;
  const env = { ...process.env };

  async function boot(stsArn: string | null) {
    sts = stsAnswering(stsArn);
    authority = new WorkloadAuthority({ allowedRoleArns: [ALIA_ROLE], fetch: sts as unknown as typeof fetch });
    const docker = new FakeDocker();
    const service = new ComputerService({
      store: new MemoryStore(),
      docker: docker.run,
      config: {
        port: 0, opsPort: 0, idleStopMs: 1_800_000, image: 'img@sha256:abc', runtime: 'runsc', deploymentId: 'test', allowedRoleArns: [ALIA_ROLE],
        maxRunning: 2, idleMs: 600_000, workspaceQuotaBytes: 1e9, maxCommandSeconds: 300, production: false,
        browser: { enabled: false, maxContexts: 3, idleMs: 600_000, selfContainer: 'self', denyCidrs: [] },
      },
      log: silent,
    });
    const app = createApp({ service, authority, log: silent, ready: () => true });
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** The fetch the client uses: the container credentials endpoint is faked, the host is real. */
  const clientFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('http://169.254.170.2')) {
      return new Response(JSON.stringify({ AccessKeyId: 'AKIDEXAMPLE', SecretAccessKey: 'secret', Token: 'session' }));
    }
    return fetch(input, init);
  };

  beforeEach(() => {
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/test';
  });

  afterEach(async () => {
    process.env = { ...env };
    await new Promise((resolve) => server?.close(resolve));
  });

  it('mints a token for the allow-listed role, and the token opens /v1', async () => {
    await boot('arn:aws:sts::237343248947:assumed-role/oxy-alia-task/task-1');
    const granted = await requestWorkloadServiceToken({ baseUrl, fetch: clientFetch });
    expect(granted.expiresIn).toBe(900);
    expect(sts).toHaveBeenCalledOnce();

    const ok = await fetch(`${baseUrl}/v1/actors/agent-1/computer`, { headers: { authorization: `Bearer ${granted.token}` } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { state: string } }).data.state).toBe('stopped');
  });

  it('refuses a role that is not on the allow-list', async () => {
    // Every service in the cluster can reach the host on the network; this is
    // what narrows it to Alia's API.
    await boot('arn:aws:sts::237343248947:assumed-role/oxy-mention-task/task-1');
    await expect(requestWorkloadServiceToken({ baseUrl, fetch: clientFetch })).rejects.toThrow(/401/);
  });

  it('refuses when STS rejects the signature', async () => {
    await boot(null);
    await expect(requestWorkloadServiceToken({ baseUrl, fetch: clientFetch })).rejects.toThrow(/401/);
  });

  it('refuses /v1 without a token, with a forged one, and with an expired one', async () => {
    await boot('arn:aws:sts::237343248947:assumed-role/oxy-alia-task/task-1');
    expect((await fetch(`${baseUrl}/v1/actors/a/computer`)).status).toBe(401);
    const forged = `v1.${Buffer.from(JSON.stringify({ sub: ALIA_ROLE, exp: 9e9 })).toString('base64url')}.AAAA`;
    expect((await fetch(`${baseUrl}/v1/actors/a/computer`, { headers: { authorization: `Bearer ${forged}` } })).status).toBe(401);
    const later = new WorkloadAuthority({ allowedRoleArns: [ALIA_ROLE], key: Buffer.alloc(32, 1), now: () => Date.now() - 3_600_000 });
    const expired = later.mint(ALIA_ROLE);
    const checker = new WorkloadAuthority({ allowedRoleArns: [ALIA_ROLE], key: Buffer.alloc(32, 1) });
    expect(checker.verifyToken(expired)).toBeNull();
    expect(checker.verifyToken(checker.mint(ALIA_ROLE))).toBe(ALIA_ROLE);
  });
});

describe('what an attestation must carry', () => {
  const authority = (now = Date.now()) =>
    new WorkloadAuthority({
      allowedRoleArns: [ALIA_ROLE],
      fetch: stsAnswering('arn:aws:sts::237343248947:assumed-role/oxy-alia-task/t') as unknown as typeof fetch,
      now: () => now,
    });
  const amzDate = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const headers = (nonce: string, over: Record<string, string> = {}) => ({
    host: 'sts.amazonaws.com',
    'x-amz-date': amzDate(Date.now()),
    'x-oxy-attestation-nonce': nonce,
    authorization: 'AWS4-HMAC-SHA256 Credential=AKID/20260101/us-east-1/sts/aws4_request, SignedHeaders=host;x-amz-date;x-oxy-attestation-nonce, Signature=abc',
    ...over,
  });

  it('accepts a well-formed one once — a nonce is single-use', async () => {
    const a = authority();
    const nonce = a.issueNonce();
    await expect(a.exchange({ provider: 'aws-iam', nonce, attestation: { headers: headers(nonce) } })).resolves.toMatchObject({ appName: 'alia' });
    await expect(a.exchange({ provider: 'aws-iam', nonce, attestation: { headers: headers(nonce) } })).rejects.toMatchObject({ reason: 'unknown_challenge' });
  });

  it.each([
    ['a nonce this host never issued', (n: string) => ({ nonce: 'oxy-issued-nonce', h: headers(n) }), 'unknown_challenge'],
    ['a host that is not STS', (n: string) => ({ nonce: n, h: headers(n, { host: 'sts.amazonaws.com.attacker.example' }) }), 'host_not_sts'],
    ['no signature', (n: string) => ({ nonce: n, h: headers(n, { authorization: 'Bearer x' }) }), 'unsigned'],
    ['an unsigned nonce', (n: string) => ({ nonce: n, h: headers(n, { authorization: 'AWS4-HMAC-SHA256 Credential=x, SignedHeaders=host;x-amz-date, Signature=abc' }) }), 'nonce_unsigned'],
    ['a different signed nonce', (n: string) => ({ nonce: n, h: headers('other') }), 'nonce_mismatch'],
    ['an old signature', (n: string) => ({ nonce: n, h: headers(n, { 'x-amz-date': amzDate(Date.now() - 10 * 60_000) }) }), 'stale'],
  ])('refuses %s', async (_label, build, reason) => {
    const a = authority();
    const nonce = a.issueNonce();
    const { nonce: sent, h } = build(nonce);
    await expect(a.exchange({ provider: 'aws-iam', nonce: sent, attestation: { headers: h } })).rejects.toMatchObject({ reason });
  });

  it('refuses another provider', async () => {
    const a = authority();
    await expect(a.exchange({ provider: 'gcp', nonce: a.issueNonce(), attestation: {} })).rejects.toMatchObject({ reason: 'unsupported_provider' });
  });
});
