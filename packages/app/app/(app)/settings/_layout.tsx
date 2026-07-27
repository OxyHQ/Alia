import { View } from "react-native";
import { Stack } from "expo-router";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { useIsLargeScreen } from "@/lib/hooks/use-is-large-screen";

/**
 * Two-pane settings. At `md`+ the section column lives here, inside the content
 * panel, so the app drawer stays the app drawer. Below `md` there is no column:
 * `/settings` is the menu and each section is a screen with a back arrow.
 */
export default function SettingsLayout() {
  const isLargeScreen = useIsLargeScreen();

  return (
    <View className="flex-1 flex-row bg-background">
      {isLargeScreen && <SettingsSidebar />}
      <View className="flex-1">
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "transparent" } }} />
      </View>
    </View>
  );
}
