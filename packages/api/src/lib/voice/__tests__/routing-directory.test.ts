import { describe, expect, it, vi } from 'vitest';
import { addressPolicy, discoverVoiceAddress } from '../routing-directory.js';

describe('server-owned peer addresses', () => {
  const allows = addressPolicy('10.20.0.0/16');
  it('admits only exact VPC IPv4 addresses and refuses hostnames, link-local and foreign networks', () => {
    expect(allows('10.20.2.17')).toBe(true);
    for (const value of [
      '10.21.2.17',
      '127.0.0.1',
      '169.254.170.2',
      'example.com',
      '::1',
      '10.20.2.17:3001',
    ])
      expect(allows(value)).toBe(false);
    expect(() => addressPolicy('0.0.0.0/0')).toThrow();
  });
  it('reads only the exact metadata endpoint and exact awsvpc container network without cookies or redirects', async () => {
    const request = vi.fn(async () =>
      Response.json({ Networks: [{ NetworkMode: 'awsvpc', IPv4Addresses: ['10.20.2.17'] }] }),
    );
    await expect(
      discoverVoiceAddress('http://169.254.170.2/v4/fixture', allows, request),
    ).resolves.toBe('10.20.2.17');
    expect(request).toHaveBeenCalledWith(
      new URL('http://169.254.170.2/v4/fixture'),
      expect.objectContaining({ redirect: 'error', credentials: 'omit', cache: 'no-store' }),
    );
    for (const uri of [
      'http://localhost/v4/a',
      'http://169.254.170.2:3000/v4/a',
      'http://169.254.170.2/v4/a?url=bad',
      'https://169.254.170.2/v4/a',
    ]) {
      request.mockClear();
      await expect(discoverVoiceAddress(uri, allows, request)).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    }
  });
  it('fails closed on missing, multiple or foreign addresses and bounds metadata bytes', async () => {
    for (const addresses of [[], ['10.20.1.1', '10.20.2.1'], ['10.21.1.1']]) {
      await expect(
        discoverVoiceAddress('http://169.254.170.2/v4/a', allows, async () =>
          Response.json({ Networks: [{ NetworkMode: 'awsvpc', IPv4Addresses: addresses }] }),
        ),
      ).rejects.toThrow();
    }
    await expect(
      discoverVoiceAddress(
        'http://169.254.170.2/v4/a',
        allows,
        async () => new Response('x'.repeat(65537)),
      ),
    ).rejects.toThrow('limit');
  });
});
