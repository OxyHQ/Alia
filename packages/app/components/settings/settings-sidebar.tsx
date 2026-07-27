import React from "react";
import { View, ScrollView } from "react-native";
import { Text } from "@/components/ui/text";
import { SidebarRow } from "@/components/sidebar/primitives";
import { useRouter, usePathname } from "expo-router";
import { useTranslation } from "@/lib/hooks/use-translation";
import { SETTINGS_GROUPS, activeSettingsSection } from "@/components/settings/sections";

/** Section column of the two-pane settings layout. Only mounted at `md`+. */
export const SettingsSidebar = React.memo(function SettingsSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();

  const activeId = React.useMemo(() => activeSettingsSection(pathname), [pathname]);

  return (
    <ScrollView
      className="w-60 shrink-0 border-r border-border"
      contentContainerClassName="p-2 gap-3"
    >
      <Text className="text-lg font-bold text-foreground px-2 pt-2">
        {t("settings.title")}
      </Text>

      {SETTINGS_GROUPS.map((group) => (
        <View key={group.titleKey} className="gap-px">
          <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase px-2 pb-1">
            {t(group.titleKey)}
          </Text>
          {group.sections.map((section) => (
            <SidebarRow
              key={section.id}
              icon={section.icon}
              label={t(section.labelKey)}
              onPress={() => router.replace(section.route)}
              active={activeId === section.id}
            />
          ))}
        </View>
      ))}
    </ScrollView>
  );
});
