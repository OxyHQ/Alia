import { View, ScrollView } from "react-native";
import { useTranslation } from "@/lib/hooks/use-translation";
import { SkillsSection } from "@/components/settings/skills-section";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function SettingsSkillsScreen() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("settings.sections.skills")} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <SkillsSection />
      </ScrollView>
    </View>
  );
}
