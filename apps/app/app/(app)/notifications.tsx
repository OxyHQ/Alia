import { View, ScrollView, Pressable, Platform } from "react-native";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { useRouter } from "expo-router";
import { ArrowLeft, Bell, BellOff, CheckCheck, Zap, Clock, Eye, AlertTriangle, MessageSquare, X } from "lucide-react-native";
import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@oxyhq/services";
import * as ExpoNotifications from "expo-notifications";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";

import { useTranslation } from "@/hooks/useTranslation";
import {
  useNotifications,
  useMarkAsRead,
  useMarkAllAsRead,
  useDismissNotification,
} from "@/lib/hooks/use-notifications";

const TYPE_ICONS: Record<string, typeof Zap> = {
  trigger_result: Zap,
  proactive_insight: Eye,
  daily_briefing: Clock,
  price_alert: AlertTriangle,
  reminder: Bell,
  chat_response_ready: MessageSquare,
  agent_task_complete: Zap,
};

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'border-l-red-500',
  high: 'border-l-orange-400',
  normal: 'border-l-blue-400',
  low: 'border-l-muted-foreground',
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

export default function NotificationsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { isAuthenticated } = useAuth();

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
      router.replace("/login");
    }
  }, [isAuthenticated]);

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
      setPushEnabled(status === "granted");
    } catch {
      setPermissionStatus("unavailable");
    } finally {
      setPushLoading(false);
    }
  };

  const handleTogglePush = async (value: boolean) => {
    if (Platform.OS === 'web') return;
    if (value) {
      const { status } = await ExpoNotifications.requestPermissionsAsync();
      setPermissionStatus(status);
      setPushEnabled(status === "granted");
    } else {
      setPushEnabled(false);
    }
  };

  const handleNotificationPress = useCallback((notification: any) => {
    if (notification.status !== 'read') {
      markAsRead.mutate(notification._id);
    }
    // If the notification has a conversationId, navigate to that conversation
    if (notification.conversationId) {
      router.push(`/(app)/c/${notification.conversationId}`);
    }
  }, [markAsRead, router]);

  const notifications = data?.notifications || [];
  const unreadCount = data?.unreadCount || 0;

  const StatusIcon = pushEnabled ? Bell : BellOff;

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 py-6 border-b border-border">
        <View className="flex-row items-center justify-between mb-4">
          <Pressable onPress={() => router.back()} className="flex-row items-center">
            <ArrowLeft size={16} className="text-muted-foreground mr-2" />
            <Text className="text-sm text-muted-foreground">{t('common.back')}</Text>
          </Pressable>
          <Pressable onPress={() => setShowSettings(s => !s)} className="p-2">
            <Bell size={18} className="text-muted-foreground" />
          </Pressable>
        </View>
        <View className="flex-row items-center justify-between">
          <View>
            <Text className="text-2xl font-semibold text-foreground">{t('notifications.title')}</Text>
            {unreadCount > 0 && (
              <Text className="text-sm text-muted-foreground mt-1">
                {unreadCount} unread
              </Text>
            )}
          </View>
          {unreadCount > 0 && (
            <Pressable
              onPress={() => markAllAsRead.mutate()}
              className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted active:bg-muted/80"
            >
              <CheckCheck size={14} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">Mark all read</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* Push Settings (collapsible) */}
      {showSettings && (
        <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)}>
          <View className="px-6 py-4 border-b border-border bg-muted/30">
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-3 flex-1">
                <StatusIcon size={20} className="text-muted-foreground" />
                <View className="flex-1">
                  <Text className="text-sm font-medium text-foreground">{t('notifications.pushNotifications')}</Text>
                  <Text className="text-xs text-muted-foreground mt-0.5">
                    {t('notifications.pushDescription')}
                  </Text>
                </View>
              </View>
              <Switch
                value={pushEnabled}
                onValueChange={handleTogglePush}
                disabled={pushLoading}
              />
            </View>
            {permissionStatus === "denied" && (
              <View className="mt-3 p-3 rounded-lg bg-muted">
                <Text className="text-xs text-muted-foreground">
                  {t('notifications.permissionDenied')}
                </Text>
              </View>
            )}
          </View>
        </Animated.View>
      )}

      {/* Notification Feed */}
      {isLoading ? (
        <View className="items-center justify-center py-12">
          <Text className="text-sm text-muted-foreground">Loading...</Text>
        </View>
      ) : notifications.length === 0 ? (
        <View className="items-center justify-center py-16 px-6">
          <Bell size={32} className="text-muted-foreground mb-3" />
          <Text className="text-base font-medium text-foreground mb-1">No notifications yet</Text>
          <Text className="text-sm text-muted-foreground text-center">
            Set up triggers and routines to get proactive updates from Clarity.
          </Text>
        </View>
      ) : (
        <View className="py-2">
          {notifications.map((notification: any) => {
            const Icon = TYPE_ICONS[notification.type] || Bell;
            const isUnread = notification.status !== 'read' && notification.status !== 'dismissed';
            const priorityBorder = PRIORITY_COLORS[notification.priority] || PRIORITY_COLORS.normal;

            return (
              <Pressable
                key={notification._id}
                onPress={() => handleNotificationPress(notification)}
                className={`px-6 py-4 border-b border-border border-l-2 ${priorityBorder} ${isUnread ? 'bg-muted/20' : ''} active:bg-muted/40`}
              >
                <View className="flex-row items-start gap-3">
                  <View className={`mt-0.5 ${isUnread ? 'opacity-100' : 'opacity-50'}`}>
                    <Icon size={16} className="text-muted-foreground" />
                  </View>
                  <View className="flex-1">
                    <View className="flex-row items-center justify-between mb-1">
                      <Text className={`text-sm ${isUnread ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground'}`} numberOfLines={1}>
                        {notification.title}
                      </Text>
                      <View className="flex-row items-center gap-2">
                        <Text className="text-xs text-muted-foreground">
                          {timeAgo(notification.createdAt)}
                        </Text>
                        <Pressable
                          onPress={(e) => {
                            e.stopPropagation();
                            dismiss.mutate(notification._id);
                          }}
                          className="p-1"
                          hitSlop={8}
                        >
                          <X size={12} className="text-muted-foreground" />
                        </Pressable>
                      </View>
                    </View>
                    <Text className="text-xs text-muted-foreground" numberOfLines={3}>
                      {notification.body}
                    </Text>
                  </View>
                </View>
              </Pressable>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}
