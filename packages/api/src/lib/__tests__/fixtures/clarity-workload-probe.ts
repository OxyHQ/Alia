import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CLARITY_SERVICE_AUDIENCE } from '@clarity.surf/sdk/server';

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
  assert.equal(req.url, '/v1/jobs/search');
  assert.equal(req.headers.cookie, undefined);
  const payload = req.headers.authorization?.slice(7).split('.')[1];
  assert.ok(payload);
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.aud, CLARITY_SERVICE_AUDIENCE);
  calls += 1;
  if (calls === 1) {
    res.writeHead(401);
    return res.end('{"error":"expired"}');
  }
  return res.end('{"data":[],"mode":"lexical"}');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
process.env.OXY_API_URL = origin;
process.env.CLARITY_API_URL = origin;
const { clarityClient, disposeClarityClient } = await import('../../clarity-client.js');
const { oxyServiceClient } = await import('../../oxy-service-client.js');
try {
  const client = clarityClient();
  assert.equal(client, clarityClient());
  assert.deepEqual((await client.jobs.search({ query: 'engineer' })).data, []);
  assert.equal(calls, 2);
  assert.equal(exchanges.length, 2);
  assert.ok(
    exchanges.every(
      (exchange) =>
        exchange.protocolVersion === 2 &&
        exchange.audience === CLARITY_SERVICE_AUDIENCE &&
        exchange.scopes === undefined,
    ),
  );
  disposeClarityClient();
  await assert.rejects(client.jobs.search({ query: 'engineer' }), /disposed/i);
  assert.equal(calls, 2);
  const replacement = clarityClient();
  assert.notEqual(replacement, client);
  assert.deepEqual((await replacement.jobs.search({ query: 'engineer' })).data, []);
  assert.equal(calls, 3);
  process.stdout.write('ALIA_CLARITY_WORKLOAD_OK\n');
} finally {
  disposeClarityClient();
  oxyServiceClient()?.dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
