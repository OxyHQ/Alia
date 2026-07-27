import { View } from "react-native";
import { Stack } from "expo-router";
import { ContentPanel } from "@oxyhq/bloom/content-panel";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { useIsLargeScreen } from "@/lib/hooks/use-is-large-screen";

/**
 * Two-pane settings: at `md`+ the section column and the section being edited
 * are sibling `ContentPanel`s with the shell gutter between them. Below `md`
 * there is no column — `/settings` is the menu and each section is a screen.
 */
export default function SettingsLayout() {
  const isLargeScreen = useIsLargeScreen();

  return (
    <View className="flex-1 flex-row md:gap-2">
      {isLargeScreen && (
        <View className="w-60 shrink-0">
          <ContentPanel surfaceClassName="bg-background">
            <SettingsSidebar />
          </ContentPanel>
        </View>
      )}
      <View className="flex-1">
        <ContentPanel surfaceClassName="bg-background">
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "transparent" } }} />
        </ContentPanel>
      </View>
    </View>
  );
}
