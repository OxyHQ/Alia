import React from "react";
import { ScrollView } from "react-native";
import { Text } from "@/components/ui/text";
import { SettingsListGroup, SettingsListItem } from "@oxyhq/bloom/settings-list";
import { useRouter } from "expo-router";
import { useTranslation } from "@/lib/hooks/use-translation";
import { useColorScheme } from "@/lib/useColorScheme";
import { SETTINGS_GROUPS } from "@/components/settings/sections";

/** Section column of the two-pane settings layout. Only mounted at `md`+. */
export const SettingsSidebar = React.memo(function SettingsSidebar() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useColorScheme();

  return (
    <ScrollView className="flex-1" contentContainerClassName="p-2">
      <Text className="text-lg font-bold text-foreground px-2 py-2">
        {t("settings.title")}
      </Text>

      {SETTINGS_GROUPS.map((group) => (
        <SettingsListGroup key={group.titleKey} title={t(group.titleKey)}>
          {group.sections.map(({ id, route, icon: Icon, labelKey }) => (
            <SettingsListItem
              key={id}
              icon={<Icon size={18} color={colors.mutedForeground} />}
              title={t(labelKey)}
              onPress={() => router.replace(route)}
            />
          ))}
        </SettingsListGroup>
      ))}
    </ScrollView>
  );
});
