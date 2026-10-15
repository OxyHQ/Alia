import { describe, expect, it } from 'vitest';
import { isUnrecoverableSubscriptionError } from '../web-push.js';

/**
 * Production, 2026-10-12: FCM answered `403` "the VAPID credentials in the
 * authorization header do not correspond to the credentials used to create the
 * subscriptions" for the same two subscriptions on every notification. Such a
 * subscription can never succeed again, so it is deactivated like a `410`.
 */
describe('isUnrecoverableSubscriptionError', () => {
  it('treats a gone subscription as unusable', () => {
    expect(isUnrecoverableSubscriptionError({ statusCode: 410 })).toBe(true);
    expect(isUnrecoverableSubscriptionError({ statusCode: 404 })).toBe(true);
  });

  it('treats a VAPID key mismatch as unusable', () => {
    const body =
      'the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions.\n';
    expect(isUnrecoverableSubscriptionError({ statusCode: 403, body })).toBe(true);
    expect(isUnrecoverableSubscriptionError({ statusCode: 401, body })).toBe(true);
  });

  it('keeps a subscription on a refusal that may be our own fault', () => {
    expect(isUnrecoverableSubscriptionError({ statusCode: 403, body: 'Forbidden' })).toBe(false);
    expect(isUnrecoverableSubscriptionError({ statusCode: 401 })).toBe(false);
    expect(isUnrecoverableSubscriptionError({ statusCode: 500, body: 'VAPID' })).toBe(false);
    expect(isUnrecoverableSubscriptionError(new Error('socket hang up'))).toBe(false);
    expect(isUnrecoverableSubscriptionError(null)).toBe(false);
  });
});
