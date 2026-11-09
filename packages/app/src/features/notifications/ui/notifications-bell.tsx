import {
  useMarkAllAsRead,
  useMarkAsRead,
  useNotifications,
} from '@/features/notifications/runtime/use-notifications';
import { notificationCenterItems } from '@/features/notifications/model/notification-center-items';
import { notificationIcon } from '@/features/notifications/ui/notification-icons';
import { useTranslation } from '@/shared/i18n/use-translation';
import { NotificationBell } from '@oxy.so/bloom/app-shell';
import { useOxy } from '@oxy.so/services/ui/client';
import { useRouter } from 'expo-router';
import React from 'react';

/**
 * The header's notification bell: Bloom's `NotificationBell`, the unread count on its glyph and
 * Bloom's notification center in the popover under it. Signed out there is no inbox, so nothing
 * is drawn.
 *
 * Opening an item's "open" action marks it read and goes to its conversation; "Mark all read"
 * clears the count. The center keeps its own tabs and read state.
 */
export const NotificationsBell = React.memo(function NotificationsBell() {
  const { isAuthenticated } = useOxy();
  const { t } = useTranslation();
  const router = useRouter();
  const { data } = useNotifications();
  const markAsRead = useMarkAsRead();
  const markAllAsRead = useMarkAllAsRead();
  const notifications = data?.notifications;
  const openLabel = t('notifications.open');

  const items = React.useMemo(
    () => notificationCenterItems(notifications ?? [], { openLabel, iconFor: notificationIcon }),
    [notifications, openLabel],
  );

  const onAction = React.useCallback(
    (notificationId: string, actionId: string) => {
      if (actionId !== 'open') return;
      const notification = notifications?.find((item) => item._id === notificationId);
      if (notification?.status !== 'read') markAsRead.mutate(notificationId);
      if (notification?.conversationId) router.push(`/(app)/c/${notification.conversationId}`);
    },
    [notifications, markAsRead, router],
  );

  if (!isAuthenticated) return null;
  return (
    <NotificationBell
      notifications={items}
      unreadCount={data?.unreadCount ?? 0}
      onAction={onAction}
      onMarkAllRead={() => markAllAsRead.mutate()}
      accessibilityLabel={t('sidebar.notifications')}
    />
  );
});
