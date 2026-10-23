import { afterEach, expect, it, vi } from 'vitest';
import { createLogger } from '../logger';
afterEach(() => vi.restoreAllMocks());
it('redacts requester credentials in messages and nested transport errors', () => {
  const sink = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const error = Object.assign(new Error('Request rejected: Bearer opaque-requester-proof'), {
    request: {
      headers: {
        authorization: 'Bearer service-proof',
        'X-Oxy-Requester-Token': 'nested-requester-proof',
      },
    },
  });
  createLogger('test').error('Request failed', error);
  const output = sink.mock.calls.map(([chunk]) => String(chunk)).join('');
  for (const proof of ['opaque-requester-proof', 'service-proof', 'nested-requester-proof'])
    expect(output).not.toContain(proof);
  expect(output).toContain('[REDACTED]');
});
