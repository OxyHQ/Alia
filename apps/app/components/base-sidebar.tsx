import React from "react";
import { View, ScrollView } from "react-native";

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
  return (
    <View className={`flex-1 ${backgroundColor}`}>
      {/* Header */}
      <View className="border-b border-border/50 p-4 md:p-3">
        {header}
      </View>

      {/* Optional Top Section */}
      {topSection && (
        <View className="p-3 md:p-2">
          {topSection}
        </View>
      )}

      {/* Navigation Links */}
      <View className="px-3 md:px-2 pb-3 md:pb-2 pt-3 md:pt-2 gap-1">
        {navigation}
      </View>

      {/* Scrollable Content */}
      {scrollableContent && (
        <ScrollView
          className="flex-1 px-3 md:px-2"
          onScroll={onScroll}
          scrollEventThrottle={400}
          showsVerticalScrollIndicator={showScrollIndicator}
        >
          {scrollableContent}
        </ScrollView>
      )}

      {/* Footer */}
      <View className="border-t border-border/50 p-3 md:p-2">
        {footer}
      </View>
    </View>
  );
});
