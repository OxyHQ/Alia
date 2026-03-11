import React, { useState, useCallback } from "react";
import { View, ScrollView, NativeSyntheticEvent, NativeScrollEvent } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useColorScheme } from "@/lib/useColorScheme";

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
  /** Background color class (default: bg-background for white) */
  backgroundColor?: string;
  /** Optional callback for scroll events */
  onScroll?: (event: any) => void;
  /** Show vertical scroll indicator */
  showScrollIndicator?: boolean;
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
  backgroundColor = "bg-sidebar",
  onScroll,
  showScrollIndicator = false,
}: BaseSidebarProps) {
  const { colors } = useColorScheme();
  const [showTopGradient, setShowTopGradient] = useState(false);
  const [showBottomGradient, setShowBottomGradient] = useState(true);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    setShowTopGradient(contentOffset.y > 2);
    setShowBottomGradient(contentOffset.y + layoutMeasurement.height < contentSize.height - 2);
    onScroll?.(event);
  }, [onScroll]);

  return (
    <View className={`flex-1 ${backgroundColor} border-r border-sidebar-border`}>
      {/* Header */}
      <View className="p-4 md:p-3">
        {header}
      </View>

      {/* Scrollable area with gradient overlays */}
      <View className="flex-1">
        {/* Top gradient */}
        {showTopGradient && (
          <LinearGradient
            colors={[colors.sidebar, "transparent"]}
            style={{ position: "absolute", top: 0, left: 0, right: 0, height: GRADIENT_HEIGHT, zIndex: 10, pointerEvents: "none" }}
          />
        )}

        <ScrollView
          className="flex-1 px-3 md:px-2"
          contentContainerStyle={scrollOverlay ? { paddingBottom: OVERLAY_PADDING } : undefined}
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
            colors={["transparent", colors.sidebar]}
            style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: GRADIENT_HEIGHT, zIndex: 10, pointerEvents: "none" }}
          />
        )}

        {/* Floating overlay above footer */}
        {scrollOverlay && (
          <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10 }} className="items-center pb-1">
            <LinearGradient
              colors={["transparent", colors.sidebar, colors.sidebar]}
              locations={[0, 0.8, 1]}
              style={{ position: "absolute", top: -60, left: 0, right: 0, bottom: 0, pointerEvents: "none" }}
            />
            <View style={{ width: "90%" }}>
              {scrollOverlay}
            </View>
          </View>
        )}
      </View>

      {/* Footer */}
      <View className="p-3 md:p-2">
        {footer}
      </View>
    </View>
  );
});
