import * as React from "react";
import { View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Dialog } from "@oxy.so/bloom/dialog";
import { AiChatResizeHandle } from "@oxy.so/bloom/ai-chat";
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
  /** Whether the desktop panel draws the divider facing the content. */
  divided?: boolean;
  /**
   * Called while the reader drags the panel's inner edge, with the distance
   * from where the drag began. Omit it and the panel is a fixed width, as it
   * was before — the drag is a capability of the panels that can honour it,
   * not of every panel.
   *
   * Desktop only. On a phone the panel is a near-full-bleed sheet and there is
   * no second column to trade width with.
   */
  onResize?: (dx: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  /** Keyboard nudge, so the width is reachable without a pointer. */
  onNudge?: (dx: number) => void;
  /** Names the separator for assistive technology. */
  resizeLabel?: string;
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
  divided = true,
  onResize,
  onResizeStart,
  onResizeEnd,
  onNudge,
  resizeLabel,
}: PanelProps) {
  const { width: screenWidth } = useWindowDimensions();
  const isLargeScreen = useIsLargeScreen();
  const insets = useSafeAreaInsets();

  // Desktop: Render as part of flex layout
  if (isLargeScreen) {
    if (!open) return null;

    return (
      <View style={{ flexDirection: "row" }}>
        {/* Bloom's grip, on the edge the panel shares with the chat.
         *
         * `AiChatResizeHandle` is the template's own separator: a 20px strip
         * straddling the edge that reveals a grip under the pointer, keeps it
         * up while dragging, and reports the distance from where the drag
         * began. Reimplementing that — the hover reveal, the pointer capture,
         * the keyboard nudge, the `separator` role — is exactly the "copy of
         * Bloom kept locally" #608 §11 is about.
         *
         * It reports a DELTA, so the caller owns the width and the clamping.
         * That is why it sits here rather than in the store: the panel knows
         * which edge it is, and the store knows what the number means. */}
        {onResize === undefined || side !== "right" ? null : (
          <AiChatResizeHandle
            onResizeStart={onResizeStart}
            onResize={onResize}
            onResizeEnd={onResizeEnd}
            onNudge={onNudge}
            label={resizeLabel}
          />
        )}
        <View
          style={{ width, paddingTop: insets.top }}
          className={cn(
            "bg-background",
            divided && (side === "right" ? "border-l border-border" : "border-r border-border"),
            className
          )}
        >
          {children}
        </View>
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
