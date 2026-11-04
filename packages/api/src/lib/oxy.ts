/**
 * Alia's one Oxy client: the only module that constructs an `OxyServer`.
 *
 * Every other Oxy surface this process touches goes through it — verifying an
 * inbound session or service token (`middleware/auth.ts`, the socket
 * handshake), reading a profile, the service lane (Oxy Files, agency, tasks,
 * capability tickets), and another Oxy product (Kaana, Clarity, CrowdSource,
 * Syra, integrations) through `oxy.createServiceClient(...)` or that product's
 * `*ForOxyService(oxy)` SDK. A call made AS the person behind a request is
 * `oxy.withUser(req, …)`; the shared session here is never given a token.
 *
 * - Workload identity, no keys (oxy ADR 0026/0049): the ECS task role in
 *   production, or a local AWS profile through the same provider.
 * - `serviceIdentity: 'when-anonymous'`: a session-less read (`users.get`,
 *   `users.lookupMany`, `byUsername`) carries Alia's service token instead of
 *   going out anonymous and being charged to the shared NAT address. A process
 *   that cannot attest keeps sending it anonymous; anything that NEEDS the
 *   service lane fails at the call, and that failure is reported as one.
 * - `expectedAudience`: every `middleware.auth()` / `service()` mount accepts
 *   service tokens minted for Alia (`oxy-service:<ALIA_APPLICATION_ID>`).
 */
import { ALIA_APPLICATION_ID, ALIA_SERVICE_AUDIENCE } from '@alia.onl/server';
import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';

export const OXY_API_URL = process.env.OXY_API_URL?.trim() || 'https://api.oxy.so';

/**
 * A local Oxy may be using the production database through a development
 * tunnel, and its session checks can exceed the SDK's 5 s default under load.
 * Only loopback gets the longer deadline; hosted deployments keep the default.
 */
function loopbackRequestTimeout(baseURL: string): number | undefined {
  const { hostname } = new URL(baseURL);
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
    ? 15_000
    : undefined;
}

export const oxy = new OxyServer({
  baseURL: OXY_API_URL,
  applicationId: ALIA_APPLICATION_ID,
  serviceIdentity: 'when-anonymous',
  expectedAudience: ALIA_SERVICE_AUDIENCE,
  workloadCredentials: createAwsWorkloadCredentialProvider(),
  requestTimeout: loopbackRequestTimeout(OXY_API_URL),
});
