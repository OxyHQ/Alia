import * as React from "react";
import { View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Dialog } from "@oxyhq/bloom/dialog";
import { cn } from "@/lib/utils";
import { useIsLargeScreen } from "@/lib/hooks/use-is-large-screen";

interface PanelProps {
  /** Whether the panel is open */
  open: boolean;
  /** Callback when panel should close */
  onClose: () => void;
  /** Which side the panel appears on */
  side?: "left" | "right";
  /** Width of the panel on desktop */
  width?: number;
  /** Children to render inside the panel */
  children: React.ReactNode;
  /** Additional className for the panel container */
  className?: string;
}

/**
 * Panel - A responsive side panel component
 *
 * - Desktop (>=768px): Renders as part of flex layout
 * - Mobile (<768px): Renders as a Bloom side-sheet `Dialog`, which owns the
 *   backdrop, the slide animation and the dismiss gesture
 */
export function Panel({
  open,
  onClose,
  side = "right",
  width = 320,
  children,
  className,
}: PanelProps) {
  const { width: screenWidth } = useWindowDimensions();
  const isLargeScreen = useIsLargeScreen();
  const insets = useSafeAreaInsets();

  // Desktop: Render as part of flex layout
  if (isLargeScreen) {
    if (!open) return null;

    return (
      <View
        style={{ width, paddingTop: insets.top }}
        className={cn(
          "bg-background",
          side === "right" ? "border-l border-border" : "border-r border-border",
          className
        )}
      >
        {children}
      </View>
    );
  }

  // Mobile: a near-full-bleed side sheet. Bloom caps the width so a strip of
  // backdrop stays tappable on the opposite edge.
  return (
    <Dialog
      open={open}
      onClose={onClose}
      placement={side}
      width={screenWidth}
      contentPadding={0}
      scrollable={false}
      panelClassName="bg-background"
    >
      <View
        className={cn("flex-1 bg-background", className)}
        style={{ paddingTop: insets.top }}
      >
        {children}
      </View>
    </Dialog>
  );
}
