import { View, ScrollView } from "react-native";
import { useEffect } from "react";
import { useOxy } from "@oxyhq/services";
import { useRouter } from "expo-router";
import { useTranslation } from "@/hooks/useTranslation";
import { AccountSection } from "@/components/settings/account-section";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function SettingsAccountScreen() {
  const router = useRouter();
  const { isAuthenticated } = useOxy();
  const { t } = useTranslation();

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated]);

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("settings.sections.account")} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <AccountSection />
      </ScrollView>
    </View>
  );
}
