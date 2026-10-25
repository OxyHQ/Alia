import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALIA_APPLICATION_ID,
  ALIA_API_WORKLOAD_ID,
  ALIA_SERVICE_AUDIENCE,
} from '@alia.onl/server/internal';
const state = vi.hoisted(() => ({ principal: undefined as any, introspect: vi.fn() }));
vi.mock('../oxy', () => ({
  oxy: {
    middleware: {
      service: () => async (req: any, _res: any, next: () => void) => {
        req.serviceApp = state.principal;
        next();
      },
    },
    introspectServiceToken: state.introspect,
  },
}));
import { requireAliaApi, requireAccountContext, authorizeInternalUpgrade } from '../internal-auth';
import { accountOwnership } from '../account-ownership';
const ACCOUNT = '0192f3a4-b5c6-7d8e-9f01-23456789abcd';
function response() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}
beforeEach(() => {
  vi.clearAllMocks();
  state.principal = {
    authority: 'first_party',
    appId: ALIA_APPLICATION_ID,
    credentialId: ALIA_API_WORKLOAD_ID,
  };
});
describe('internal product authority', () => {
  it('accepts only the exact live Alia API workload, never a user session', async () => {
    const req: any = { headers: {} };
    const next = vi.fn();
    await requireAliaApi(req, response(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toBeUndefined();
  });
  it.each([
    { authority: 'external', appId: ALIA_APPLICATION_ID, credentialId: ALIA_API_WORKLOAD_ID },
    { authority: 'first_party', appId: 'another-app', credentialId: ALIA_API_WORKLOAD_ID },
    { authority: 'first_party', appId: ALIA_APPLICATION_ID, credentialId: 'another-workload' },
    undefined,
  ])('refuses wrong authority or workload', async (principal) => {
    state.principal = principal;
    const next = vi.fn();
    const res = response();
    await requireAliaApi({ headers: {} } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
  it('does not treat an Oxy user header as internal account authority', () => {
    const next = vi.fn();
    const res = response();
    requireAccountContext({ headers: { 'x-oxy-user-id': ACCOUNT } } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
  it('verifies live workload identity before opening an account-bound socket', async () => {
    state.introspect.mockResolvedValue({
      active: true,
      audience: ALIA_SERVICE_AUDIENCE,
      authority: 'first_party',
      applicationId: ALIA_APPLICATION_ID,
      credentialId: ALIA_API_WORKLOAD_ID,
    });
    const headers = { authorization: 'Bearer proof', 'x-alia-account-context': ACCOUNT };
    expect(await authorizeInternalUpgrade(headers)).toBe(ACCOUNT);
    state.introspect.mockResolvedValue({ active: false });
    expect(await authorizeInternalUpgrade(headers)).toBeNull();
  });
});
describe('account row ownership', () => {
  it('refuses a session belonging to a different account', async () => {
    const guard = accountOwnership(async () => 'another-account');
    const next = vi.fn();
    const res = response();
    const req: any = {
      path: '/sessions/opaque/chats',
      headers: { 'x-alia-account-context': ACCOUNT },
    };
    await requireAliaApi(req, response(), () => {});
    await guard(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });
  it('overwrites a client body owner with the verified internal context', async () => {
    const guard = accountOwnership(async () => ACCOUNT);
    const next = vi.fn();
    const req: any = {
      path: '/sessions/connect',
      headers: { 'x-alia-account-context': ACCOUNT },
      body: { oxyUserId: 'forged' },
    };
    await requireAliaApi(req, response(), () => {});
    await guard(req, response(), next);
    expect(req.body.oxyUserId).toBe(ACCOUNT);
    expect(next).toHaveBeenCalledOnce();
  });
});
