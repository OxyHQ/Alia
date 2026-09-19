/**
 * The `/ws` upgrade and subscription rules.
 *
 * ## What this defends
 *
 * The terminal and browser HTTP routes are mounted behind `requireSecret` +
 * `requireSessionOwner`, and that guard's own comment states the property:
 * the in-memory session map "can never be addressed across users even if the
 * gateway secret leaks or a path is forged".
 *
 * `/ws` had neither check. It accepted any connection that could reach the
 * port and took `sessionId` straight off the client's first frame, so one
 * `{"type":"subscribe","sessionId":"<someone else>:<id>"}` was enough to
 * receive another user's PTY stream — every keystroke and every byte of
 * output — from `broadcastTerminal`.
 *
 * ## Why these are unit tests and not an end-to-end socket test
 *
 * A test that stands up the server and races a real WebSocket against it can
 * only reasonably assert the happy path and one refusal; the interesting part
 * here is the TABLE of refusals, and a missing entry in that table is the bug.
 * Testing the predicates directly is what makes covering all of them cheap.
 *
 * The `verifySecret` double is deliberately exact-match rather than a spy that
 * records its arguments: what matters is that a WRONG secret is refused, not
 * which comparison function was reached.
 */

import { describe, expect, it } from 'vitest';

import { authorizeUpgrade, maySubscribe } from '../subscription-auth';

const SECRET = 'gateway-secret-value';
const USER = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const OTHER = 'ffffffffffffffffffffffff';

/**
 * A uuid v7 id — the shape ids actually have since the Postgres cutover.
 *
 * The fixtures above are 24-char ObjectId hex, which is why this gate's
 * original `/^[a-f0-9]{24}$/` check passed every test in this file while
 * refusing every real account in production.
 */
const USER_V7 = '0192f3a4-b5c6-7d8e-9f01-23456789abcd';

const exactMatch = (candidate: string, expected: string) => candidate === expected;

const goodHeaders = { 'x-gateway-secret': SECRET, 'x-oxy-user-id': USER };

describe('authorizeUpgrade', () => {
  it('accepts the credentials the API gateway already sends', () => {
    expect(authorizeUpgrade(goodHeaders, SECRET, exactMatch)).toEqual({ ok: true, userId: USER });
  });

  it('is case-insensitive about header names, as HTTP is', () => {
    const verdict = authorizeUpgrade(
      { 'X-Gateway-Secret': SECRET, 'X-Oxy-User-Id': USER },
      SECRET,
      exactMatch,
    );
    expect(verdict).toEqual({ ok: true, userId: USER });
  });

  it('refuses a connection presenting no secret', () => {
    expect(authorizeUpgrade({ 'x-oxy-user-id': USER }, SECRET, exactMatch)).toMatchObject({
      ok: false,
    });
  });

  it('refuses a connection presenting the wrong secret', () => {
    const verdict = authorizeUpgrade(
      { ...goodHeaders, 'x-gateway-secret': 'not-it' },
      SECRET,
      exactMatch,
    );
    expect(verdict).toMatchObject({ ok: false, reason: 'invalid gateway secret' });
  });

  it('refuses a valid secret with no user context', () => {
    expect(authorizeUpgrade({ 'x-gateway-secret': SECRET }, SECRET, exactMatch)).toMatchObject({
      ok: false,
      reason: 'user context required',
    });
  });

  it('accepts a uuid v7 user id, which is what ids actually are now', () => {
    // The bug this file could not see: ids are uuid v7 since the Postgres
    // cutover (pre-cutover rows keep their 24-char ObjectId hex), and a gate
    // written as `/^[a-f0-9]{24}$/` refuses every one of them. The failure mode
    // is the worst kind for a realtime path — the upgrade is declined, the
    // client sees a socket that will not connect, and nothing names the id as
    // the reason. `packages/api/src/socket.ts` records the identical bug being
    // hit in the agent-session subscribe path.
    expect(
      authorizeUpgrade({ ...goodHeaders, 'x-oxy-user-id': USER_V7 }, SECRET, exactMatch),
    ).toEqual({ ok: true, userId: USER_V7 });
  });

  it('refuses a user id that is not the shape the gateway forwards', () => {
    for (const bad of [
      '',
      'nope',
      USER.slice(0, 23),
      `${USER}0`,
      `${USER};DROP`,
      // A uuid v4. Accepting "any uuid" would be the lazy widening; nothing in
      // this ecosystem mints a v4, so one arriving is a client error rather
      // than an id to look up — `isLiveEntityId` pins the version nibble.
      '0192f3a4-b5c6-4d8e-9f01-23456789abcd',
      // Right length and alphabet, wrong variant nibble.
      '0192f3a4-b5c6-7d8e-1f01-23456789abcd',
      // A v7 with its separators stripped: the same 32 characters, not an id.
      USER_V7.replace(/-/g, ''),
    ]) {
      expect(
        authorizeUpgrade({ ...goodHeaders, 'x-oxy-user-id': bad }, SECRET, exactMatch),
      ).toMatchObject({ ok: false });
    }
  });

  it('refuses a repeated header rather than picking one of the values', () => {
    // Taking the first would let a caller append a valid-looking value after a
    // hostile one and rely on whichever end the reader happens to take.
    const verdict = authorizeUpgrade(
      { 'x-gateway-secret': ['wrong', SECRET], 'x-oxy-user-id': USER },
      SECRET,
      exactMatch,
    );
    expect(verdict).toMatchObject({ ok: false });
  });

  it('refuses everything when the service has no secret configured', () => {
    // Fail closed: an unset secret must not mean "no check".
    expect(authorizeUpgrade(goodHeaders, undefined, exactMatch)).toMatchObject({ ok: false });
    expect(authorizeUpgrade(goodHeaders, '', exactMatch)).toMatchObject({ ok: false });
  });
});

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
