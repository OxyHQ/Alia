import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { sweepAllExpiredRows } from '@oxyhq/db/expiry';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { EXPIRY_TARGETS } from '../expiryTargets';
import { notifications, pushTokens, webPushSubscriptions } from '../schema/notifications';
import {
  countUnread,
  createNotification,
  deactivatePushToken,
  deactivatePushTokenByToken,
  deactivateWebPushSubscription,
  dismissNotification,
  hasActivePushToken,
  hasActiveWebPushSubscription,
  listActivePushTokens,
  listActiveWebPushSubscriptions,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  setDeliveryStatus,
  touchPushTokens,
  upsertPushToken,
  upsertWebPushSubscription,
} from '../notifications/notificationRepository';

/**
 * Notifications and their delivery credentials, against a REAL server.
 *
 * Two things here can only be tested against a real Postgres: the CHECK binding
 * `dismissed_at` to `status` — which a status transition has to carry or the
 * route 500s — and the three write counts, whose differences a single call
 * cannot see.
 *
 * This file owns `notifications` for the repository behaviour;
 * `notifications.pgdb.test.ts` keeps the CONSTRAINT tests, which insert rows
 * with explicit ids under their own `oxy_user_id`s and never count.
 */

let db: ApiDatabase;
const USER = 'oxy-notif-user';
const OTHER = 'oxy-notif-other';

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  /**
   * Scoped to THIS file's accounts, not table-wide.
   *
   * `notifications.pgdb.test.ts` exercises the CHECK constraints against its own
   * `oxy_user_id`s in the same database, and a `delete(notifications)` here
   * wiped its rows mid-run — which surfaced as `expected '5' to be '9'` in that
   * file, a failure naming nothing about the cause. Every count in this file is
   * already scoped by account, so scoping the cleanup costs nothing and removes
   * the coupling entirely.
   */
  await db.delete(notifications).where(inArray(notifications.oxyUserId, [USER, OTHER]));
  await db.delete(pushTokens).where(inArray(pushTokens.oxyUserId, [USER, OTHER]));
  await db
    .delete(webPushSubscriptions)
    .where(inArray(webPushSubscriptions.oxyUserId, [USER, OTHER]));
});

const newNotification = (oxyUserId = USER) =>
  createNotification(db, {
    oxyUserId,
    type: 'agent_task_complete',
    title: 'Done',
    body: 'Your task finished.',
    channels: ['in_app'],
    deliveryStatus: { in_app: 'pending' },
    priority: 'normal',
  });

describe('creating and delivering', () => {
  it('stores as sent, with the per-channel map and no dismissal', async () => {
    const row = await newNotification();
    expect(row).toMatchObject({
      oxyUserId: USER,
      status: 'sent',
      priority: 'normal',
      channels: ['in_app'],
      deliveryStatus: { in_app: 'pending' },
      readAt: null,
      dismissedAt: null,
    });
  });

  it('replaces the delivery map whole, with no markModified to forget', async () => {
    const row = await newNotification();
    await setDeliveryStatus(db, row.id, { in_app: 'sent', push: 'failed' });

    const [after] = await db.select().from(notifications).where(eq(notifications.id, row.id));
    expect(after?.deliveryStatus).toEqual({ in_app: 'sent', push: 'failed' });
  });
});

describe('the dismissed_at CHECK survives every transition the routes allow', () => {
  it('writes dismissed_at when dismissing', async () => {
    const row = await newNotification();
    expect(await dismissNotification(db, row.id, USER)).toBe(true);

    const [after] = await db.select().from(notifications).where(eq(notifications.id, row.id));
    expect(after?.status).toBe('dismissed');
    expect(after?.dismissedAt).toBeInstanceOf(Date);
  });

  it('CLEARS dismissed_at when a dismissed notification is marked read', async () => {
    /**
     * The transition Mongo allowed — `markAsRead` has no status filter — and the
     * one that violates `(status = 'dismissed') = (dismissed_at is not null)` if
     * the column is left behind. Without the clear this THROWS, so the route
     * 500s on a perfectly ordinary sequence.
     */
    const row = await newNotification();
    await dismissNotification(db, row.id, USER);

    await expect(markNotificationRead(db, row.id, USER)).resolves.toBe(true);

    const [after] = await db.select().from(notifications).where(eq(notifications.id, row.id));
    expect(after?.status).toBe('read');
    expect(after?.dismissedAt).toBeNull();
    expect(after?.readAt).toBeInstanceOf(Date);
  });

  it('leaves a re-dismissed notification original dismissed_at alone', async () => {
    /**
     * `status <> 'dismissed'` does two jobs. This is the second: the 90-day
     * sweep measures from `dismissed_at`, so advancing it on every dismissal
     * would let a row be kept alive indefinitely by re-dismissing it.
     */
    const row = await newNotification();
    await dismissNotification(db, row.id, USER);
    const [first] = await db.select().from(notifications).where(eq(notifications.id, row.id));

    await new Promise((r) => setTimeout(r, 5));
    await dismissNotification(db, row.id, USER);
    const [second] = await db.select().from(notifications).where(eq(notifications.id, row.id));

    expect(second?.dismissedAt?.getTime()).toBe(first?.dismissedAt?.getTime());
  });
});

describe('the three write counts, which only a REPEAT can tell apart', () => {
  it('dismiss reports true once and false thereafter — modifiedCount, not matchedCount', async () => {
    /**
     * The source set `status` and nothing else, so a second dismissal matched
     * and modified nothing: `modifiedCount` 0, and the route answered 404. A
     * bare `rowCount` would say 1 and answer success. This is the assertion the
     * narrowed filter exists for.
     */
    const row = await newNotification();
    expect(await dismissNotification(db, row.id, USER)).toBe(true);
    expect(await dismissNotification(db, row.id, USER)).toBe(false);
  });

  it('markAsRead reports true on a REPEAT — read_at changes every time', async () => {
    /**
     * The opposite decision on a neighbouring call. Because the source also set
     * `read_at: new Date()`, a repeat genuinely modified the document, so
     * `modifiedCount` was already behaving like `matchedCount` and `rowCount` is
     * faithful with no predicate. Narrowing this one would 404 a retry.
     */
    const row = await newNotification();
    expect(await markNotificationRead(db, row.id, USER)).toBe(true);
    expect(await markNotificationRead(db, row.id, USER)).toBe(true);
  });

  it('markAllAsRead counts only the rows it changed, and zero on a repeat', async () => {
    await newNotification();
    await newNotification();
    const dismissed = await newNotification();
    await dismissNotification(db, dismissed.id, USER);
    await newNotification(OTHER);

    // Two unread for USER; the dismissed one is out of the filter, and OTHER's
    // is out of scope.
    expect(await markAllNotificationsRead(db, USER)).toBe(2);
    expect(await markAllNotificationsRead(db, USER)).toBe(0);

    // The dismissed one was NOT swept up into `read`.
    const [still] = await db.select().from(notifications).where(eq(notifications.id, dismissed.id));
    expect(still?.status).toBe('dismissed');
  });

  it('reports false for another account notification, and leaves it alone', async () => {
    const row = await newNotification(OTHER);
    expect(await markNotificationRead(db, row.id, USER)).toBe(false);
    expect(await dismissNotification(db, row.id, USER)).toBe(false);

    const [after] = await db.select().from(notifications).where(eq(notifications.id, row.id));
    expect(after?.status).toBe('sent');
  });
});

describe('unread counting', () => {
  it('counts pending and sent, and nothing else', async () => {
    await newNotification();
    const read = await newNotification();
    const dismissed = await newNotification();
    await markNotificationRead(db, read.id, USER);
    await dismissNotification(db, dismissed.id, USER);

    expect(await countUnread(db, USER)).toBe(1);
  });

  it('is scoped to the account and returns a real number', async () => {
    await newNotification(OTHER);
    const n = await countUnread(db, USER);
    expect(typeof n).toBe('number');
    expect(n).toBe(0);
  });
});

describe('listing', () => {
  it('filters by status and by type, and reports a matching total', async () => {
    const a = await newNotification();
    await newNotification();
    await markNotificationRead(db, a.id, USER);

    const all = await listNotifications(db, { oxyUserId: USER, limit: 30, offset: 0 });
    expect(all.total).toBe(2);

    const read = await listNotifications(db, {
      oxyUserId: USER,
      status: 'read',
      limit: 30,
      offset: 0,
    });
    expect(read.total).toBe(1);
    expect(read.notifications.map((n) => n.id)).toEqual([a.id]);

    const wrongType = await listNotifications(db, {
      oxyUserId: USER,
      type: 'price_alert',
      limit: 30,
      offset: 0,
    });
    expect(wrongType).toEqual({ notifications: [], total: 0 });
  });

  it('orders newest first with a TOTAL order, so paging cannot repeat a row', async () => {
    // Same `created_at` on all three: uuid v7 is not monotonic within a
    // millisecond, so `created_at DESC` alone is a partial order.
    const at = new Date('2021-05-05T00:00:00.000Z');
    await db.insert(notifications).values(
      ['n-a', 'n-b', 'n-c'].map((id) => ({
        id,
        oxyUserId: USER,
        type: 'reminder' as const,
        title: 'T',
        body: 'B',
        createdAt: at,
      })),
    );

    const page = await listNotifications(db, { oxyUserId: USER, limit: 3, offset: 0 });
    expect(page.notifications.map((n) => n.id)).toEqual(['n-c', 'n-b', 'n-a']);
  });

  it('never returns another account notifications', async () => {
    await newNotification(OTHER);
    expect(await listNotifications(db, { oxyUserId: USER, limit: 30, offset: 0 })).toEqual({
      notifications: [],
      total: 0,
    });
  });
});

describe('push tokens', () => {
  const TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';

  it('registers once and reactivates on a repeat, never duplicating', async () => {
    const first = await upsertPushToken(db, USER, TOKEN, 'device-1', 'ios');
    await deactivatePushToken(db, USER, TOKEN);
    const second = await upsertPushToken(db, USER, TOKEN);

    expect(second.id).toBe(first.id);
    expect(second.active).toBe(true);
    expect(await listActivePushTokens(db, USER)).toHaveLength(1);
  });

  it('does NOT erase device or platform when a re-registration omits them', async () => {
    // The source's `$set` included them only when truthy. Writing them
    // unconditionally would null out what the first registration recorded.
    await upsertPushToken(db, USER, TOKEN, 'device-1', 'ios');
    const second = await upsertPushToken(db, USER, TOKEN);

    expect(second.deviceId).toBe('device-1');
    expect(second.platform).toBe('ios');
  });

  it('lets two accounts register the SAME token independently', async () => {
    // The unique is `(oxy_user_id, token)`, not `token` — a shared device must
    // not push one account registration out.
    await upsertPushToken(db, USER, TOKEN);
    await upsertPushToken(db, OTHER, TOKEN);
    expect(await listActivePushTokens(db, USER)).toHaveLength(1);
    expect(await listActivePushTokens(db, OTHER)).toHaveLength(1);
  });

  it('deactivates by token ALONE for a DeviceNotRegistered receipt', async () => {
    // An Expo receipt names no account, so this one deliberately is not scoped.
    await upsertPushToken(db, USER, TOKEN);
    await upsertPushToken(db, OTHER, TOKEN);
    await deactivatePushTokenByToken(db, TOKEN);

    expect(await listActivePushTokens(db, USER)).toEqual([]);
    expect(await listActivePushTokens(db, OTHER)).toEqual([]);
  });

  it('reports whether a scoped deactivation matched, which is what the 404 turns on', async () => {
    await upsertPushToken(db, USER, TOKEN);
    expect(await deactivatePushToken(db, OTHER, TOKEN)).toBe(false);
    expect(await deactivatePushToken(db, USER, TOKEN)).toBe(true);
    // `matchedCount`, so a second call still MATCHES the row and reports true —
    // faithful to the source, which read `matchedCount` here and not `modified`.
    expect(await deactivatePushToken(db, USER, TOKEN)).toBe(true);
  });

  it('answers hasActivePushToken only while one is active', async () => {
    expect(await hasActivePushToken(db, USER)).toBe(false);
    await upsertPushToken(db, USER, TOKEN);
    expect(await hasActivePushToken(db, USER)).toBe(true);
    await deactivatePushToken(db, USER, TOKEN);
    expect(await hasActivePushToken(db, USER)).toBe(false);
  });

  it('touches last_used_at for the given ids, and no-ops on an empty list', async () => {
    const token = await upsertPushToken(db, USER, TOKEN);
    expect(token.lastUsedAt).toBeNull();

    // An empty list is a no-op. Drizzle renders `inArray(col, [])` as a false
    // predicate, so this is asserting that the call is SAFE, not that a guard is
    // what makes it so — mutating the guard away leaves this green.
    await touchPushTokens(db, []);
    await touchPushTokens(db, [token.id]);

    const [after] = await db.select().from(pushTokens).where(eq(pushTokens.id, token.id));
    expect(after?.lastUsedAt).toBeInstanceOf(Date);
  });
});

describe('web push subscriptions', () => {
  const ENDPOINT = 'https://push.example/endpoint/abc';

  it('registers once and updates the keys on a repeat', async () => {
    const first = await upsertWebPushSubscription(db, USER, ENDPOINT, 'p1', 'a1');
    const second = await upsertWebPushSubscription(db, USER, ENDPOINT, 'p2', 'a2');

    expect(second.id).toBe(first.id);
    expect(second.keysP256dh).toBe('p2');
    expect(second.keysAuth).toBe('a2');
    expect(await listActiveWebPushSubscriptions(db, USER)).toHaveLength(1);
  });

  it('keeps the keys as two flat columns the delivery path can rebuild', async () => {
    // The nested `keys` sub-document became `keys_p256dh` / `keys_auth`, and
    // `deliverWebPush` rebuilds `{ p256dh, auth }` from them.
    const sub = await upsertWebPushSubscription(db, USER, ENDPOINT, 'p256', 'auth');
    expect({ p256dh: sub.keysP256dh, auth: sub.keysAuth }).toEqual({
      p256dh: 'p256',
      auth: 'auth',
    });
  });

  it('reports whether a deactivation matched, scoped to the account', async () => {
    await upsertWebPushSubscription(db, USER, ENDPOINT, 'p', 'a');
    expect(await deactivateWebPushSubscription(db, OTHER, ENDPOINT)).toBe(false);
    expect(await deactivateWebPushSubscription(db, USER, ENDPOINT)).toBe(true);
    expect(await hasActiveWebPushSubscription(db, USER)).toBe(false);
  });
});

describe('the dismissal sweep reaches these rows', () => {
  it('reaps a notification dismissed more than 90 days ago and keeps a recent one', async () => {
    /**
     * The repository half of the conditional-TTL story: the sweep is registered
     * against `dismissed_at`, so what matters is that `dismissNotification`
     * writes the column the sweep reads. Instants are RELATIVE to now — a
     * hardcoded date in a shared database is a time bomb for whichever file next
     * changes an import.
     */
    const old = await newNotification();
    const recent = await newNotification();
    await dismissNotification(db, old.id, USER);
    await dismissNotification(db, recent.id, USER);

    await db
      .update(notifications)
      .set({ dismissedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) })
      .where(eq(notifications.id, old.id));

    await sweepAllExpiredRows(db, EXPIRY_TARGETS);

    const remaining = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.oxyUserId, USER));
    expect(remaining.map((r) => r.id)).toEqual([recent.id]);
  });

  it('never reaps a notification that was never dismissed, however old', async () => {
    // The whole reason the condition became a column. A sweep from `created_at`
    // would take this row.
    const row = await newNotification();
    await db
      .update(notifications)
      .set({ createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) })
      .where(eq(notifications.id, row.id));

    await sweepAllExpiredRows(db, EXPIRY_TARGETS);

    const [after] = await db.select().from(notifications).where(eq(notifications.id, row.id));
    expect(after).toBeDefined();
  });
});
