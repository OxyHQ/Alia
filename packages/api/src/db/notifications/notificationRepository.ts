/**
 * Notifications and their delivery credentials, on Postgres.
 *
 * ## Three write counts, three different answers
 *
 * Mongo reports `matchedCount` AND `modifiedCount`; Postgres reports only
 * `rowCount`, which behaves like `matchedCount`. Every caller here read
 * `modifiedCount`, and they do NOT all port the same way — it is a per-call-site
 * decision, and getting one backwards 404s a retry or succeeds where it should
 * not.
 *
 *  - **`markAsRead`** set `status` AND `read_at: new Date()`. The timestamp
 *    differs on every call, so a repeat DID modify the document and
 *    `modifiedCount` was already behaving like `matchedCount`. `rowCount` is
 *    faithful with no predicate.
 *  - **`markAllAsRead`** filtered `status in ('pending','sent')` and set
 *    `status = 'read'`, so every matched row changes. `rowCount` is faithful —
 *    the narrowed-filter case.
 *  - **`dismissNotification`** set `status` and NOTHING else. Dismissing an
 *    already-dismissed notification matched but modified nothing, so Mongo
 *    returned 0 and the route answered 404. A bare `rowCount` would return 1 and
 *    answer success. The filter is narrowed with `status <> 'dismissed'` to
 *    reproduce it — which is also what keeps `dismissed_at` from being ADVANCED
 *    by a second dismissal, and the 90-day sweep measures from that column.
 *
 * ## `dismissed_at` is a CHECK, so a status transition has to carry it
 *
 * `(status = 'dismissed') = (dismissed_at is not null)`. Two consequences the
 * port has to honour or the route 500s:
 *
 *  - dismissing must WRITE `dismissed_at`;
 *  - marking a DISMISSED notification as read must CLEAR it. Mongo allowed that
 *    transition (`markAsRead` has no status filter), and leaving the column set
 *    would violate the constraint. Clearing it is the honest answer: the row is
 *    no longer dismissed, so it is no longer awaiting a dismissal sweep.
 */

import { and, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import {
  notifications,
  pushTokens,
  webPushSubscriptions,
  type NotificationChannel,
  type NotificationPriority,
  type NotificationStatus,
  type NotificationTypeValue,
} from '../schema/notifications';

export type NotificationRow = typeof notifications.$inferSelect;
export type PushTokenRow = typeof pushTokens.$inferSelect;
export type WebPushSubscriptionRow = typeof webPushSubscriptions.$inferSelect;

/** The statuses that count as unread. */
const UNREAD_STATUSES = ['pending', 'sent'] as const;

export interface NewNotification {
  readonly oxyUserId: string;
  readonly type: NotificationTypeValue;
  readonly title: string;
  readonly body: string;
  readonly data?: Record<string, unknown> | undefined;
  readonly channels: NotificationChannel[];
  readonly deliveryStatus: Record<string, string>;
  readonly priority: NotificationPriority;
  readonly triggerId?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly expiresAt?: Date | undefined;
}

/** Persist a notification as `sent`, before any channel is attempted. */
export async function createNotification(
  db: ApiDatabase,
  input: NewNotification,
): Promise<NotificationRow> {
  const [row] = await db
    .insert(notifications)
    .values({
      oxyUserId: input.oxyUserId,
      type: input.type,
      title: input.title,
      body: input.body,
      data: input.data ?? null,
      channels: input.channels,
      deliveryStatus: input.deliveryStatus,
      status: 'sent',
      priority: input.priority,
      triggerId: input.triggerId ?? null,
      conversationId: input.conversationId ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();

  if (!row) throw new Error('notification insert returned no row');
  return row;
}

/**
 * Replace the per-channel delivery map once every channel has been attempted.
 *
 * The source mutated the sub-document and called `markModified` + `save()`. A
 * `jsonb` column is written whole, so this takes the finished map — which also
 * removes the `markModified` failure mode, where forgetting the call silently
 * persisted nothing.
 */
export async function setDeliveryStatus(
  db: ApiDatabase,
  notificationId: string,
  deliveryStatus: Record<string, string>,
): Promise<void> {
  await db.update(notifications).set({ deliveryStatus }).where(eq(notifications.id, notificationId));
}

export interface NotificationFilters {
  readonly oxyUserId: string;
  readonly status?: NotificationStatus | undefined;
  readonly type?: NotificationTypeValue | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface NotificationPage {
  readonly notifications: NotificationRow[];
  readonly total: number;
}

export async function listNotifications(
  db: ApiDatabase,
  filters: NotificationFilters,
): Promise<NotificationPage> {
  const conditions = [eq(notifications.oxyUserId, filters.oxyUserId)];
  if (filters.status) conditions.push(eq(notifications.status, filters.status));
  if (filters.type) conditions.push(eq(notifications.type, filters.type));
  const where = and(...conditions);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(where)
      // `id` breaks a `created_at` tie: `generatedId()` is a uuid v7 and is NOT
      // monotonic within a millisecond, so without it the order is partial and
      // offset paging can repeat a row.
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(filters.limit)
      .offset(filters.offset),
    db.select({ n: count() }).from(notifications).where(where),
  ]);

  return { notifications: rows, total: totalRow?.n ?? 0 };
}

/** `count(*)::int` — an aggregate would otherwise reach JS as a `bigint` string. */
export async function countUnread(db: ApiDatabase, oxyUserId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.oxyUserId, oxyUserId),
        inArray(notifications.status, [...UNREAD_STATUSES]),
      ),
    );

  return row?.n ?? 0;
}

/**
 * Mark one notification read.
 *
 * `dismissed_at` is CLEARED, because the CHECK binds it to the status and Mongo
 * permitted dismissed -> read. No status predicate: the source had none, and
 * `read_at` changes on every call so a repeat legitimately reports success.
 */
export async function markNotificationRead(
  db: ApiDatabase,
  notificationId: string,
  oxyUserId: string,
): Promise<boolean> {
  const result = await db
    .update(notifications)
    .set({ status: 'read', readAt: new Date(), dismissedAt: null })
    .where(and(eq(notifications.id, notificationId), eq(notifications.oxyUserId, oxyUserId)));

  return result.count > 0;
}

/** Mark every unread notification read, returning how many changed. */
export async function markAllNotificationsRead(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<number> {
  const result = await db
    .update(notifications)
    .set({ status: 'read', readAt: new Date() })
    .where(
      and(
        eq(notifications.oxyUserId, oxyUserId),
        inArray(notifications.status, [...UNREAD_STATUSES]),
      ),
    );

  return result.count;
}

/**
 * Dismiss one notification, reporting whether this call is what dismissed it.
 *
 * `status <> 'dismissed'` is load-bearing twice over: it reproduces the
 * `modifiedCount > 0` the route turns into a 404, and it stops a second
 * dismissal ADVANCING `dismissed_at` — which would push back the 90-day sweep
 * and let a row be kept alive indefinitely by re-dismissing it.
 */
export async function dismissNotification(
  db: ApiDatabase,
  notificationId: string,
  oxyUserId: string,
): Promise<boolean> {
  const result = await db
    .update(notifications)
    .set({ status: 'dismissed', dismissedAt: new Date() })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.oxyUserId, oxyUserId),
        ne(notifications.status, 'dismissed'),
      ),
    );

  return result.count > 0;
}

// ── Push tokens ─────────────────────────────────────────────────────

export async function hasActivePushToken(db: ApiDatabase, oxyUserId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(pushTokens)
    .where(and(eq(pushTokens.oxyUserId, oxyUserId), eq(pushTokens.active, true)))
    .limit(1);

  return row !== undefined;
}

export async function listActivePushTokens(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<PushTokenRow[]> {
  return db
    .select()
    .from(pushTokens)
    .where(and(eq(pushTokens.oxyUserId, oxyUserId), eq(pushTokens.active, true)));
}

/**
 * Register a device token, reactivating it if this account already had it.
 *
 * `device_id` and `platform` are written only when SUPPLIED, matching the
 * source's conditional `$set` — a re-registration that omits them must not erase
 * what the first one recorded.
 */
export async function upsertPushToken(
  db: ApiDatabase,
  oxyUserId: string,
  token: string,
  deviceId?: string,
  platform?: string,
): Promise<PushTokenRow> {
  const optional = {
    ...(deviceId ? { deviceId } : {}),
    ...(platform ? { platform } : {}),
  };

  const [row] = await db
    .insert(pushTokens)
    .values({ oxyUserId, token, active: true, ...optional })
    .onConflictDoUpdate({
      target: [pushTokens.oxyUserId, pushTokens.token],
      set: { active: true, ...optional, updatedAt: new Date() },
    })
    .returning();

  if (!row) throw new Error('push token upsert returned no row');
  return row;
}

/** `rowCount` is `matchedCount` here, which is what the source read. */
export async function deactivatePushToken(
  db: ApiDatabase,
  oxyUserId: string,
  token: string,
): Promise<boolean> {
  const result = await db
    .update(pushTokens)
    .set({ active: false })
    .where(and(eq(pushTokens.oxyUserId, oxyUserId), eq(pushTokens.token, token)));

  return result.count > 0;
}

/** Deactivate by TOKEN alone — an Expo `DeviceNotRegistered` names no account. */
export async function deactivatePushTokenByToken(db: ApiDatabase, token: string): Promise<void> {
  await db.update(pushTokens).set({ active: false }).where(eq(pushTokens.token, token));
}

export async function deactivatePushTokenById(db: ApiDatabase, id: string): Promise<void> {
  await db.update(pushTokens).set({ active: false }).where(eq(pushTokens.id, id));
}

/**
 * Record that these tokens were just delivered to.
 *
 * The empty-list early return is an OPTIMISATION, not a correctness guard — that
 * was measured: mutating it away left the whole suite green, because drizzle
 * renders `inArray(col, [])` as a false predicate rather than as invalid SQL. It
 * stays because skipping a round trip that cannot match anything is free, and
 * the comment says what it actually does.
 */
export async function touchPushTokens(db: ApiDatabase, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(pushTokens)
    .set({ lastUsedAt: new Date() })
    .where(inArray(pushTokens.id, ids));
}

// ── Web push subscriptions ──────────────────────────────────────────

export async function hasActiveWebPushSubscription(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(webPushSubscriptions)
    .where(
      and(eq(webPushSubscriptions.oxyUserId, oxyUserId), eq(webPushSubscriptions.active, true)),
    )
    .limit(1);

  return row !== undefined;
}

export async function listActiveWebPushSubscriptions(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<WebPushSubscriptionRow[]> {
  return db
    .select()
    .from(webPushSubscriptions)
    .where(
      and(eq(webPushSubscriptions.oxyUserId, oxyUserId), eq(webPushSubscriptions.active, true)),
    );
}

/** The keys are a credential pair, flattened out of the nested `keys` document. */
export async function upsertWebPushSubscription(
  db: ApiDatabase,
  oxyUserId: string,
  endpoint: string,
  keysP256dh: string,
  keysAuth: string,
): Promise<WebPushSubscriptionRow> {
  const [row] = await db
    .insert(webPushSubscriptions)
    .values({ oxyUserId, endpoint, keysP256dh, keysAuth, active: true })
    .onConflictDoUpdate({
      target: [webPushSubscriptions.oxyUserId, webPushSubscriptions.endpoint],
      set: { active: true, keysP256dh, keysAuth, updatedAt: new Date() },
    })
    .returning();

  if (!row) throw new Error('web push subscription upsert returned no row');
  return row;
}

export async function deactivateWebPushSubscription(
  db: ApiDatabase,
  oxyUserId: string,
  endpoint: string,
): Promise<boolean> {
  const result = await db
    .update(webPushSubscriptions)
    .set({ active: false })
    .where(
      and(
        eq(webPushSubscriptions.oxyUserId, oxyUserId),
        eq(webPushSubscriptions.endpoint, endpoint),
      ),
    );

  return result.count > 0;
}

export async function deactivateWebPushSubscriptionById(
  db: ApiDatabase,
  id: string,
): Promise<void> {
  await db.update(webPushSubscriptions).set({ active: false }).where(eq(webPushSubscriptions.id, id));
}
