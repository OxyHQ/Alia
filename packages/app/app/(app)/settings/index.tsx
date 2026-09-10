import { View, ScrollView } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { SettingsListGroup, SettingsListItem } from "@oxy.so/bloom/settings-list";
import { useTranslation } from "@/lib/hooks/use-translation";
import { SettingsHeader } from "@/components/settings/settings-header";
import { useColorScheme } from "@/lib/useColorScheme";
import { useSettingsLayoutMode } from "@/components/settings/layout-mode";
import { SETTINGS_GROUPS, FIRST_SETTINGS_SECTION } from "@/components/settings/sections";

export default function SettingsIndexScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useColorScheme();
  const mode = useSettingsLayoutMode();

  // Not measured yet: neither the menu nor the redirect, for a frame. A
  // redirect on a guess takes a phone away from the menu it asked for.
  if (mode === null) {
    return null;
  }

  // In split mode the section column is already on screen, so a menu here
  // would repeat it. Split is the SCENE's width, not the window's: at 768 with
  // the drawer open the scene is stacked and this menu is the navigation.
  if (mode === "split") {
    return <Redirect href={FIRST_SETTINGS_SECTION} />;
  }

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("settings.title")} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        {SETTINGS_GROUPS.map((group) => (
          <SettingsListGroup key={group.titleKey} title={t(group.titleKey)}>
            {group.sections.map(({ id, route, icon: Icon, labelKey }) => (
              <SettingsListItem
                key={id}
                icon={<Icon size={18} color={colors.mutedForeground} />}
                title={t(labelKey)}
                onPress={() => router.push(route)}
              />
            ))}
          </SettingsListGroup>
        ))}
      </ScrollView>
    </View>
  );
}
