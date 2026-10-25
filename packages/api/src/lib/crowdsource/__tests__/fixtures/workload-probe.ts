import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CROWDSOURCE_SERVICE_AUDIENCE } from '@crowdsource.you/core';

// Synthetic temporary AWS credentials sign the local issuer fixture only.
delete process.env.AWS_PROFILE;
delete process.env.AWS_DEFAULT_PROFILE;
process.env.AWS_ACCESS_KEY_ID = 'ASIA_TEST';
process.env.AWS_SECRET_ACCESS_KEY = 'fixture';
process.env.AWS_SESSION_TOKEN = 'fixture';
process.env.AWS_CREDENTIAL_EXPIRATION = new Date(Date.now() + 3600000).toISOString();
process.env.AWS_REGION = 'us-west-2';
const exchanges: { audience: string; protocolVersion: number; scopes?: unknown }[] = [];
let calls = 0;
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  res.setHeader('content-type', 'application/json');
  if (req.url?.endsWith('/challenge')) return res.end('{"nonce":"fixture"}');
  if (req.url?.endsWith('/workload')) {
    const exchange = JSON.parse(body);
    exchanges.push(exchange);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      type: 'service',
      authority: 'first_party',
      appId: 'alia',
      credentialId: 'wl_alia',
      ownerAccountId: 'owner',
      environment: 'development',
      iss: 'oxy-auth',
      iat: now,
      exp: now + 300,
      aud: exchange.audience,
      nonce: exchanges.length,
    };
    return res.end(
      JSON.stringify({
        token: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`,
        expiresIn: 300,
      }),
    );
  }
  assert.ok(req.url === '/v1/applications/me' || req.url === '/v1/reports');
  assert.equal(req.headers.cookie, undefined);
  const payload = req.headers.authorization?.slice(7).split('.')[1];
  assert.ok(payload);
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.aud, CROWDSOURCE_SERVICE_AUDIENCE);
  calls += 1;
  if (calls === 1) {
    res.writeHead(401);
    return res.end('{"error":"expired"}');
  }
  if (req.url === '/v1/applications/me') return res.end('{"applicationId":"app_alia"}');
  assert.equal(req.method, 'POST');
  assert.equal(JSON.parse(body).externalReportId, 'report-one');
  res.statusCode = 202;
  return res.end('{"reportId":"rpt_one","caseId":"case_one","status":"received","merged":false}');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://localhost:${address.port}`;
process.env.OXY_API_URL = origin;
process.env.CROWDSOURCE_BASE_URL = origin;
const { getCrowdSourceClient, resetCrowdSourceClient } = await import('../../client.js');
const { oxyServiceClient } = await import('../../../oxy-service-client.js');
const report = {
  externalReportId: 'report-one',
  subject: { externalId: 'skill-one', type: 'custom.alia.skill' },
  content: 'Fixture moderation report',
  allegations: ['integrity.spam' as const],
};
try {
  const client = getCrowdSourceClient();
  assert.ok(client);
  assert.equal(client, getCrowdSourceClient());
  const receipt = await client.reports.create(report);
  assert.equal(receipt.reportId, 'rpt_one');
  assert.equal(calls, 3);
  assert.equal(exchanges.length, 2);
  assert.ok(
    exchanges.every(
      (exchange) =>
        exchange.protocolVersion === 2 &&
        exchange.audience === CROWDSOURCE_SERVICE_AUDIENCE &&
        exchange.scopes === undefined,
    ),
  );
  resetCrowdSourceClient();
  await assert.rejects(
    client.reports.create(report),
    (error) => error instanceof Error && /disposed/i.test(String(error.cause)),
  );
  assert.equal(calls, 3);
  const replacement = getCrowdSourceClient();
  assert.ok(replacement);
  assert.notEqual(replacement, client);
  assert.equal((await replacement.reports.create(report)).reportId, 'rpt_one');
  assert.equal(calls, 5);
  process.stdout.write('ALIA_CROWDSOURCE_WORKLOAD_OK\n');
} finally {
  resetCrowdSourceClient();
  oxyServiceClient()?.dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
