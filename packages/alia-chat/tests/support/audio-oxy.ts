import { afterEach } from 'vitest';
import { OxyServices } from '@oxy.so/core';

/** Real core sessions for hook tests; only the remote product/audio edges are fake. */
export function audioTestOxy(getAccount: () => string | null) {
  let oxy: OxyServices | null = null;
  let previous: string | null | undefined;
  afterEach(() => {
    oxy?.dispose();
    oxy = null;
    previous = undefined;
  });
  return () => {
    oxy ??= new OxyServices({ baseURL: 'https://api.oxy.test' });
    const account = getAccount();
    if (account !== previous) {
      previous = account;
      if (account) {
        const token = `e30.${Buffer.from(JSON.stringify({ userId: account, sessionId: 'test-session', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`;
        oxy.session.setAccessToken(token);
      } else oxy.session.clear();
    }
    return oxy;
  };
}
