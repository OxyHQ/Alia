import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useOxy } from "@oxyhq/services";
import { useTranslation } from "@/hooks/useTranslation";
import { ChevronRight } from "lucide-react-native";

export function AccountSection() {
  const { user, showBottomSheet } = useOxy();
  const { t } = useTranslation();

  const displayName = user?.name?.displayName || t('common.user');

  const initial = (user?.name?.displayName?.[0] || "U").toUpperCase();

  return (
    <View className="gap-6">
      {/* Profile Card */}
      <View className="flex-row items-center gap-4">
        <View className="w-14 h-14 rounded-full bg-muted items-center justify-center">
          <Text className="text-xl font-bold text-muted-foreground">{initial}</Text>
        </View>
        <View className="flex-1">
          <Text className="text-lg font-semibold">{displayName}</Text>
          {user?.email && (
            <Text className="text-sm text-muted-foreground">{user.email}</Text>
          )}
        </View>
      </View>

      {/* Manage Account */}
      <Button
        variant="outline"
        onPress={() => showBottomSheet?.("ManageAccount")}
        className="flex-row items-center justify-between"
      >
        <Text className="text-sm font-medium">{t("settings.account.title")}</Text>
        <ChevronRight size={16} className="text-muted-foreground" />
      </Button>
    </View>
  );
}
