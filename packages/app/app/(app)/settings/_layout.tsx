import { useCallback, useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { Stack } from "expo-router";
import { ContentPanel } from "@oxy.so/bloom/content-panel";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import {
  SettingsLayoutContext,
  settingsColumnWidth,
  settingsLayoutMode,
} from "@/components/settings/layout-mode";
import { useIsLargeScreen } from "@/lib/hooks/use-is-large-screen";
import { asViewStyle } from "@/lib/types/webStyles";
import { cn } from "@/lib/utils";

/** Painted here rather than left to `framed`: the framed panel's sticky overlays are
 *  sized to the viewport and bleed 12px past their own box, so two of them side by
 *  side paint over each other. Unframed panels carry the same look on the surface. */
const PANEL = "bg-background md:rounded-radius-28 md:border md:border-border overflow-hidden";

export default function SettingsLayout() {
  /**
   * The width this scene was given, which is what the split is decided on. The
   * window is the wrong number: at `md` the permanent drawer takes 255px of it
   * (56 once collapsed to its rail), so a column keyed to `md:` classes stood
   * beside a 273px preferences pane at 768×1024 (#548). Measured, so collapsing
   * the drawer re-decides the split without this file knowing what the drawer
   * did. `null` until the first layout: `layout-mode.ts` says why nothing below
   * may guess.
   */
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width);
    setAvailableWidth((previous) => (previous === width ? previous : width));
  }, []);
  const mode = availableWidth === null ? null : settingsLayoutMode(availableWidth);
  const columnWidth = availableWidth === null ? 0 : settingsColumnWidth(availableWidth);

  // Below `md` the panes are unframed with no gutter between them, so the
  // column draws its own edge. Split below `md` is real: at 767 the drawer is
  // an overlay and the whole window is the scene.
  const framed = useIsLargeScreen();

  return (
    <SettingsLayoutContext.Provider value={mode}>
      <View className="flex-1 flex-row md:gap-2" onLayout={handleLayout}>
        {/* Unmounted rather than 0px wide when stacked: a column with no width is
            still a second navigation to a screen reader and the tab order. */}
        {mode === "split" && (
          <View
            className={cn("shrink-0 overflow-hidden", !framed && "border-r border-border")}
            style={[
              { width: columnWidth },
              asViewStyle({ transition: "width 250ms cubic-bezier(0.22, 1, 0.36, 1)" }),
            ]}
          >
            <ContentPanel framed={false} surfaceClassName={PANEL}>
              <SettingsSidebar />
            </ContentPanel>
          </View>
        )}

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
    </SettingsLayoutContext.Provider>
  );
}
