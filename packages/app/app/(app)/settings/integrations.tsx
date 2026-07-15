import { View, ScrollView } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useTranslation } from "@/lib/hooks/use-translation";
import { IntegrationsSection } from "@/components/settings/integrations-section";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function SettingsIntegrationsScreen() {
  const { t } = useTranslation();
  const { connected } = useLocalSearchParams<{ connected?: string }>();
  const router = useRouter();

  const clearConnectedParam = () => {
    router.setParams({ connected: undefined });
  };

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("settings.sections.integrations")} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <IntegrationsSection
          connectedService={connected}
          onConnectedHandled={clearConnectedParam}
        />
      </ScrollView>
    </View>
  );
}
