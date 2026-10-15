import { describe, expect, it } from 'vitest';
import { oxyServiceIdentityResponseSchema } from '../oxy-capability-authority.js';

/**
 * `GET /capabilities/service-identity` as OxyHQServices `origin/main` answers it
 * (`routes/capabilities.ts`: `{ service: LiveAgencyServicePrincipal, catalogAppIds,
 * catalogs }`). Production logged 2,419 `service.appId Required` ZodErrors between
 * 2026-10-10 03:19Z and 2026-10-11 07:09Z because the event route parsed it with a
 * private schema that expected a field Oxy has never sent.
 */
describe('oxyServiceIdentityResponseSchema', () => {
  const oxyAnswer = {
    service: {
      applicationId: 'app_inbox',
      credentialId: 'cred_1',
      ownerAccountId: 'acct_1',
      scopes: ['capability-events:publish'],
      capabilities: ['inbox'],
    },
    catalogAppIds: ['inbox'],
    catalogs: [{ appId: 'inbox', eventTypes: ['new_email'] }],
  };

  it('reads what Oxy sends today', () => {
    const parsed = oxyServiceIdentityResponseSchema.parse(oxyAnswer);
    expect(parsed.service.scopes).toContain('capability-events:publish');
    expect(parsed.catalogs[0]?.eventTypes).toEqual(['new_email']);
  });

  it('does not break when Oxy adds a field', () => {
    expect(() =>
      oxyServiceIdentityResponseSchema.parse({
        ...oxyAnswer,
        service: { ...oxyAnswer.service, newField: 1 },
        extra: true,
      }),
    ).not.toThrow();
  });

  it('refuses a principal without an application id', () => {
    const { applicationId: _omitted, ...service } = oxyAnswer.service;
    expect(() => oxyServiceIdentityResponseSchema.parse({ ...oxyAnswer, service })).toThrow();
  });
});
