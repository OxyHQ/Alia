import { View, ScrollView } from "react-native";
import { useTranslation } from "@/hooks/useTranslation";
import { AccountsSection } from "@/components/settings/accounts-section";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function SettingsAccountsScreen() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("settings.sections.accounts")} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <AccountsSection />
      </ScrollView>
    </View>
  );
}
