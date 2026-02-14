import { View, ScrollView, Pressable, Switch, Platform } from "react-native";
import { Text } from "@/components/ui/text";
import { useRouter } from "expo-router";
import { ArrowLeft, Bell, BellOff } from "lucide-react-native";
import { useState, useEffect } from "react";
import { useAuth } from "@oxyhq/services";
import * as Notifications from "expo-notifications";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/hooks/useTranslation";

export default function NotificationsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { isDarkColorScheme } = useColorScheme();

  const [pushEnabled, setPushEnabled] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated]);

  useEffect(() => {
    checkPermissions();
  }, []);

  const checkPermissions = async () => {
    try {
      const { status } = await Notifications.getPermissionsAsync();
      setPermissionStatus(status);
      setPushEnabled(status === "granted");
    } catch {
      setPermissionStatus("unavailable");
    } finally {
      setLoading(false);
    }
  };

  const handleTogglePush = async (value: boolean) => {
    if (value) {
      const { status } = await Notifications.requestPermissionsAsync();
      setPermissionStatus(status);
      setPushEnabled(status === "granted");
    } else {
      setPushEnabled(false);
    }
  };

  const StatusIcon = pushEnabled ? Bell : BellOff;

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-6 py-6 border-b border-border">
        <Pressable onPress={() => router.back()} className="flex-row items-center mb-4">
          <ArrowLeft size={16} className="text-muted-foreground mr-2" />
          <Text className="text-sm text-muted-foreground">{t('common.back')}</Text>
        </Pressable>
        <Text className="text-2xl font-semibold text-foreground">{t('notifications.title')}</Text>
        <Text className="text-sm text-muted-foreground mt-1">
          {t('notifications.subtitle')}
        </Text>
      </View>

      {/* Push Notifications */}
      <View className="px-6 py-6 border-b border-border">
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
            disabled={loading}
            trackColor={{
              false: isDarkColorScheme ? "#333" : "#ccc",
              true: isDarkColorScheme ? "#6366f1" : "#4f46e5",
            }}
            thumbColor={Platform.OS === "android" ? "#fff" : undefined}
          />
        </View>

        {permissionStatus === "denied" && (
          <View className="mt-4 p-3 rounded-lg bg-muted">
            <Text className="text-xs text-muted-foreground">
              {t('notifications.permissionDenied')}
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}
