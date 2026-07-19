import React, { useState, useCallback } from "react";
import { View, ScrollView, NativeSyntheticEvent, NativeScrollEvent } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { withAlpha } from "@oxyhq/bloom/theme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColorScheme } from "@/lib/useColorScheme";
import { cn } from "@/lib/utils";

interface BaseSidebarProps {
  /** Header content (logo, branding, etc.) */
  header: React.ReactNode;
  /** Optional section between header and main navigation */
  topSection?: React.ReactNode;
  /** Main navigation buttons/links */
  navigation: React.ReactNode;
  /** Scrollable content area (projects, apps, history, etc.) */
  scrollableContent?: React.ReactNode;
  /** Content that floats above the footer, overlapping the scroll area */
  scrollOverlay?: React.ReactNode;
  /** Footer content (user menu, auth buttons, etc.) */
  footer: React.ReactNode;
  /** Background color class (default: bg-background, matching the drawer) */
  backgroundColor?: string;
  /** Optional callback for scroll events */
  onScroll?: (event: any) => void;
  /** Show vertical scroll indicator */
  showScrollIndicator?: boolean;
  /** Icon-rail mode: centers header, rows, and footer on the rail midline. */
  collapsed?: boolean;
}

const GRADIENT_HEIGHT = 24;
const OVERLAY_PADDING = 56;

export const BaseSidebar = React.memo(function BaseSidebar({
  header,
  topSection,
  navigation,
  scrollableContent,
  scrollOverlay,
  footer,
  backgroundColor = "bg-background",
  onScroll,
  showScrollIndicator = false,
  collapsed = false,
}: BaseSidebarProps) {
  const { colors } = useColorScheme();
  // The fade must resolve to the EXACT surface color behind it — never the
  // `transparent` keyword, which fades through black.
  const edge = colors.background;
  const edgeClear = withAlpha(edge, 0);
  const insets = useSafeAreaInsets();
  const [showTopGradient, setShowTopGradient] = useState(false);
  const [showBottomGradient, setShowBottomGradient] = useState(true);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    setShowTopGradient(prev => {
      const next = contentOffset.y > 2;
      return prev === next ? prev : next;
    });
    setShowBottomGradient(prev => {
      const next = contentOffset.y + layoutMeasurement.height < contentSize.height - 2;
      return prev === next ? prev : next;
    });
    onScroll?.(event);
  }, [onScroll]);

  return (
    <View className={`flex-1 ${backgroundColor}`}>
      {/* Header */}
      <View
        className={cn("px-2 pb-2", collapsed && "items-center")}
        style={{ paddingTop: insets.top + 8 }}
      >
        {header}
      </View>

      {/* Scrollable area with gradient overlays */}
      <View className="flex-1">
        {/* Top gradient */}
        {showTopGradient && (
          <LinearGradient
            colors={[edge, edgeClear]}
            style={{ position: "absolute", top: 0, left: 0, right: 0, height: GRADIENT_HEIGHT, zIndex: 10, pointerEvents: "none" }}
          />
        )}

        <ScrollView
          className={cn("flex-1", collapsed ? "px-0" : "px-3 md:px-2")}
          contentContainerStyle={[
            scrollOverlay ? { paddingBottom: OVERLAY_PADDING } : null,
            collapsed ? { alignItems: "center" as const } : null,
          ]}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={showScrollIndicator}
        >
          {topSection && (
            <View className="pb-3 md:pb-2 pt-3 md:pt-2">
              {topSection}
            </View>
          )}
          {navigation && (
            <View className="pb-3 md:pb-2 gap-1">
              {navigation}
            </View>
          )}
          {scrollableContent}
        </ScrollView>

        {/* Bottom gradient */}
        {showBottomGradient && !scrollOverlay && (
          <LinearGradient
            colors={[edgeClear, edge]}
            style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: GRADIENT_HEIGHT, zIndex: 10, pointerEvents: "none" }}
          />
        )}

        {/* Floating overlay above footer */}
        {scrollOverlay && (
          <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10 }} className="pb-1 px-3 md:px-2">
            <LinearGradient
              colors={[edgeClear, edge, edge]}
              locations={[0, 0.8, 1]}
              style={{ position: "absolute", top: -60, left: 0, right: 0, bottom: 0, pointerEvents: "none" }}
            />
            {scrollOverlay}
          </View>
        )}
      </View>

      {/* Footer */}
      <View
        className={cn("pt-3 md:pt-2", collapsed ? "items-center" : "px-3 md:px-2")}
        style={{ paddingBottom: insets.bottom + 12 }}
      >
        {footer}
      </View>
    </View>
  );
});
