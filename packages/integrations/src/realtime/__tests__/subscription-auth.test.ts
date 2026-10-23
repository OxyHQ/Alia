import { describe, expect, it } from 'vitest';
import { maySubscribe } from '../subscription-auth';
const USER = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const OTHER = 'ffffffffffffffffffffffff';
const USER_V7 = '0192f3a4-b5c6-7d8e-9f01-23456789abcd';
describe('maySubscribe', () => {
  it('allows a session in the connection owner namespace', () => {
    expect(maySubscribe(USER, `${USER}:my-terminal`)).toBe(true);
  });

  it('refuses another user session — the defect this file exists for', () => {
    expect(maySubscribe(USER, `${OTHER}:their-terminal`)).toBe(false);
  });

  it('refuses a user id that merely starts with the owner id', () => {
    // A bare `startsWith` would accept this: it is a DIFFERENT user whose id
    // happens to begin with the owner's.
    expect(maySubscribe('a1b2c3', 'a1b2c3d4:session')).toBe(false);
  });

  it('refuses a session id carrying no namespace at all', () => {
    expect(maySubscribe(USER, 'bare-session-id')).toBe(false);
    expect(maySubscribe(USER, `:${USER}`)).toBe(false);
  });

  it('refuses a non-string session id', () => {
    for (const value of [undefined, null, 42, {}, [`${USER}:ok`]]) {
      expect(maySubscribe(USER, value)).toBe(false);
    }
  });
});
