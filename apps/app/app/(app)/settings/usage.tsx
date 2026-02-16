import { View, ScrollView } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useTranslation } from "@/hooks/useTranslation";
import { BillingSection } from "@/components/settings/billing-section";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function SettingsBillingScreen() {
  const { t } = useTranslation();
  const { success } = useLocalSearchParams();

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("settings.sections.billing")} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <BillingSection success={success === 'true'} />
      </ScrollView>
    </View>
  );
}
