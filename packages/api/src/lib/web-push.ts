/**
 * Web Push — VAPID-based browser push notifications.
 *
 * Requires env vars: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 */

import webPush from 'web-push';
import { log } from './logger.js';

export const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contact@alia.onl';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  log.general.info('Web push VAPID configured');
} else {
  log.general.warn('VAPID keys not set — web push notifications disabled');
}

export { webPush };

/**
 * Whether a push service's refusal means THIS subscription can never be
 * delivered to again, so it must be deactivated rather than retried.
 *
 * - `404`/`410`: the browser dropped the subscription.
 * - `401`/`403` with a VAPID complaint: the subscription was created under a
 *   different application server key than the one that signs today (a rotated
 *   `VAPID_*` pair). FCM answers "the VAPID credentials in the authorization
 *   header do not correspond to the credentials used to create the
 *   subscriptions". Nothing server-side fixes it; only the client subscribing
 *   again does, and that happens once the old row stops being listed as active.
 *   Left active, every notification to that user re-sent the same doomed
 *   request and logged a warning each time.
 *
 * A bare `401`/`403` without that message is not enough: it can be a transient
 * misconfiguration on OUR side that a deploy fixes, and deactivating on it
 * would silently drop every user's subscription.
 */
export function isUnrecoverableSubscriptionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { statusCode, body } = error as { statusCode?: unknown; body?: unknown };
  if (statusCode === 404 || statusCode === 410) return true;
  if (statusCode === 401 || statusCode === 403) {
    return typeof body === 'string' && /vapid/i.test(body);
  }
  return false;
}
