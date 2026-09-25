import {
  useDismissNotification,
  useMarkAllAsRead,
  useMarkAsRead,
  useNotifications,
} from '@/features/notifications/runtime/use-notifications';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiAlarmWarningLine } from '@oxy.so/bloom/icons/RiAlarmWarningLine';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiCheckDoubleLine } from '@oxy.so/bloom/icons/RiCheckDoubleLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiEyeLine } from '@oxy.so/bloom/icons/RiEyeLine';
import { RiFlashlightLine } from '@oxy.so/bloom/icons/RiFlashlightLine';
import { RiMessage2Line } from '@oxy.so/bloom/icons/RiMessage2Line';
import { RiNotification3Line } from '@oxy.so/bloom/icons/RiNotification3Line';
import { RiNotificationOffLine } from '@oxy.so/bloom/icons/RiNotificationOffLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiTimeLine } from '@oxy.so/bloom/icons/RiTimeLine';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import type { AccentTone } from '@oxy.so/bloom/theme';
import { useTheme } from '@oxy.so/bloom/theme';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useAuth } from '@oxy.so/services';
import * as ExpoNotifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';

type IconComponent = typeof RiFlashlightLine;

const TYPE_ICONS: Record<string, IconComponent> = {
  trigger_result: RiFlashlightLine,
  proactive_insight: RiEyeLine,
  daily_briefing: RiTimeLine,
  price_alert: RiAlarmWarningLine,
  reminder: RiNotification3Line,
  chat_response_ready: RiMessage2Line,
  agent_task_complete: RiFlashlightLine,
};

/** A notification's priority, as the tone of its unread dot. */
const PRIORITY_TONES: Record<string, AccentTone> = {
  urgent: 'error',
  high: 'warning',
  normal: 'info',
  low: 'default',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Notifications: plain content on the layout's surface.
 *
 * The layout's `AiChatContainer` draws the background, the corners, the mobile
 * header and the "Notifications" crumb; this page draws the feed and its
 * controls only.
 */
export default function NotificationsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useTheme();
  const { isAuthenticated, signIn } = useAuth();

  const [pushEnabled, setPushEnabled] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<string | null>(null);
  const [pushLoading, setPushLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);

  const { data, isLoading } = useNotifications();
  const markAsRead = useMarkAsRead();
  const markAllAsRead = useMarkAllAsRead();
  const dismiss = useDismissNotification();

  useEffect(() => {
    if (!isAuthenticated) {
      signIn().catch(() => {});
    }
  }, [isAuthenticated, signIn]);

  useEffect(() => {
    checkPermissions();
  }, []);

  const checkPermissions = async () => {
    if (Platform.OS === 'web') {
      setPermissionStatus('unavailable');
      setPushLoading(false);
      return;
    }
    try {
      const { status } = await ExpoNotifications.getPermissionsAsync();
      setPermissionStatus(status);
      setPushEnabled(status === 'granted');
    } catch {
      setPermissionStatus('unavailable');
    } finally {
      setPushLoading(false);
    }
  };

  const handleTogglePush = async (value: boolean) => {
    if (Platform.OS === 'web') return;
    if (value) {
      const { status } = await ExpoNotifications.requestPermissionsAsync();
      setPermissionStatus(status);
      setPushEnabled(status === 'granted');
    } else {
      setPushEnabled(false);
    }
  };

  const handleNotificationPress = useCallback(
    (notification: any) => {
      if (notification.status !== 'read') {
        markAsRead.mutate(notification._id);
      }
      // If the notification has a conversationId, navigate to that conversation
      if (notification.conversationId) {
        router.push(`/(app)/c/${notification.conversationId}`);
      }
    },
    [markAsRead, router],
  );

  const notifications = data?.notifications || [];
  const unreadCount = data?.unreadCount || 0;

  const StatusIcon = pushEnabled ? RiNotification3Line : RiNotificationOffLine;

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-4 px-4 pb-6 pt-4"
    >
      {/* Top row: the way back, the unread count and the page's actions. */}
      <View className="flex-row flex-wrap items-center gap-2">
        <Button
          tone="neutral"
          appearance="plain"
          size="sm"
          leadingIcon={RiArrowLeftLine}
          onPress={() => router.back()}
        >
          {t('common.back')}
        </Button>
        <View className="flex-1">
          {unreadCount > 0 ? (
            <Muted>
              {t('pages.notifications.unread', { count: unreadCount })}
            </Muted>
          ) : null}
        </View>
        {unreadCount > 0 ? (
          <Button
            tone="neutral"
            appearance="subtle"
            size="sm"
            leadingIcon={RiCheckDoubleLine}
            onPress={() => markAllAsRead.mutate()}
          >
            {t('pages.notifications.markAllRead')}
          </Button>
        ) : null}
        <Button
          tone="neutral"
          appearance={showSettings ? 'subtle' : 'plain'}
          size="sm"
          icon={RiSettings3Line}
          pressed={showSettings}
          accessibilityLabel={t('notifications.pushNotifications')}
          onPress={() => setShowSettings((s) => !s)}
        />
      </View>

      {/* Push settings (collapsible) */}
      {showSettings ? (
        <SettingsListGroup>
          <SettingsListItem
            icon={<StatusIcon size="md" fill={colors.textSecondary} />}
            title={t('notifications.pushNotifications')}
            description={t('notifications.pushDescription')}
            rightElement={
              <Switch
                accessibilityLabel={t('notifications.pushNotifications')}
                value={pushEnabled}
                onValueChange={handleTogglePush}
                disabled={pushLoading}
              />
            }
          />
        </SettingsListGroup>
      ) : null}
      {showSettings && permissionStatus === 'denied' ? (
        <Admonition type="warning">
          {t('notifications.permissionDenied')}
        </Admonition>
      ) : null}

      {/* Notification feed */}
      {isLoading ? (
        <Loading text={t('common.loading')} />
      ) : notifications.length === 0 ? (
        <EmptyState
          icon={RiNotification3Line}
          title={t('pages.notifications.emptyTitle')}
          description={t('pages.notifications.emptyDescription')}
        />
      ) : (
        <View>
          {notifications.map((notification: any) => {
            const Icon = TYPE_ICONS[notification.type] || RiNotification3Line;
            const isUnread =
              notification.status !== 'read' &&
              notification.status !== 'dismissed';
            const tone =
              PRIORITY_TONES[notification.priority] || PRIORITY_TONES.normal;

            return (
              <Item
                key={notification._id}
                role="listitem"
                onPress={() => handleNotificationPress(notification)}
                leading={
                  <Badge dot color={tone} invisible={!isUnread}>
                    <Icon size="sm" fill={colors.textSecondary} />
                  </Badge>
                }
                title={
                  isUnread ? (
                    <Text variant="body-semibold" numberOfLines={1}>
                      {notification.title}
                    </Text>
                  ) : (
                    <Muted numberOfLines={1}>{notification.title}</Muted>
                  )
                }
                subtitle={
                  <Muted numberOfLines={3}>{notification.body}</Muted>
                }
                trailing={
                  <View className="flex-row items-center gap-1">
                    <Muted>{timeAgo(notification.createdAt)}</Muted>
                    <Button
                      tone="neutral"
                      appearance="plain"
                      size="xs"
                      icon={RiCloseLine}
                      stopPropagation
                      accessibilityLabel={t('pages.notifications.dismiss')}
                      onPress={() => dismiss.mutate(notification._id)}
                    />
                  </View>
                }
              />
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}
