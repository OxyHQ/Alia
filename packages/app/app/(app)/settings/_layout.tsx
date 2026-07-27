import { View } from "react-native";
import { Stack } from "expo-router";
import { ContentPanel } from "@oxyhq/bloom/content-panel";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { asViewStyle } from "@/lib/types/webStyles";

/** Painted here rather than left to `framed`: the framed panel's sticky overlays are
 *  sized to the viewport and bleed 12px past their own box, so two of them side by
 *  side paint over each other. Unframed panels carry the same look on the surface. */
const PANEL = "bg-background md:rounded-radius-28 md:border md:border-border overflow-hidden";

export default function SettingsLayout() {
  return (
    <View className="flex-1 flex-row md:gap-2">
      <View
        className="w-0 shrink-0 overflow-hidden md:w-56 lg:w-72"
        style={asViewStyle({ transition: "width 250ms cubic-bezier(0.22, 1, 0.36, 1)" })}
      >
        <ContentPanel framed={false} surfaceClassName={PANEL}>
          <SettingsSidebar />
        </ContentPanel>
      </View>

      <View className="flex-1 min-w-0">
        <ContentPanel framed={false} surfaceClassName={PANEL}>
          <Stack
            screenOptions={{
              headerShown: false,
              animation: "fade",
              contentStyle: { backgroundColor: "transparent" },
            }}
          />
        </ContentPanel>
      </View>
    </View>
  );
}
