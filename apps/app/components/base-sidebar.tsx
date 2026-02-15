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

/**
 * BaseSidebar - Reusable sidebar layout component
 *
 * Provides a consistent structure for all sidebars with:
 * - Header section (logo/branding)
 * - Optional top section (e.g., organization switcher, new chat button)
 * - Navigation section (main nav links)
 * - Scrollable content area (dynamic content like projects, apps, history)
 * - Footer section (user menu/auth)
 */
export const BaseSidebar = React.memo(function BaseSidebar({
  header,
  topSection,
  navigation,
  scrollableContent,
  footer,
  backgroundColor = "bg-background",
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
    <View className={`flex-1 ${backgroundColor} border-r border-border`}>
      {/* Header */}
      <View className="border-b border-border/50 p-4 md:p-3">
        {header}
      </View>

      {/* Scrollable area with gradient overlays */}
      <View className="flex-1">
        {/* Top gradient */}
        {showTopGradient && (
          <LinearGradient
            colors={[colors.background, "transparent"]}
            pointerEvents="none"
            style={{ position: "absolute", top: 0, left: 0, right: 0, height: GRADIENT_HEIGHT, zIndex: 10 }}
          />
        )}

        <ScrollView
          className="flex-1 px-3 md:px-2"
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
        {showBottomGradient && (
          <LinearGradient
            colors={["transparent", colors.background]}
            pointerEvents="none"
            style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: GRADIENT_HEIGHT, zIndex: 10 }}
          />
        )}
      </View>

      {/* Footer */}
      <View className="border-t border-border/50 p-3 md:p-2">
        {footer}
      </View>
    </View>
  );
});
