import * as React from "react";
import {
  View,
  Modal,
  Pressable,
  Animated,
  useWindowDimensions,
  StyleSheet,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "@/lib/utils";
import { useTheme } from "@oxyhq/bloom/theme";

const USE_NATIVE_DRIVER = Platform.OS !== "web";

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
 * - Mobile (<768px): Renders as modal with slide animation
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
  const isLargeScreen = screenWidth >= 768;
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();

  // Animation values for mobile
  const slideAnim = React.useRef(new Animated.Value(screenWidth)).current;
  const fadeAnim = React.useRef(new Animated.Value(0)).current;

  // Update animation when screen size changes
  React.useEffect(() => {
    if (!open) {
      slideAnim.setValue(side === "right" ? screenWidth : -screenWidth);
    }
  }, [screenWidth, open, side]);

  // Animate open/close on mobile
  React.useEffect(() => {
    if (!isLargeScreen) {
      if (open) {
        Animated.parallel([
          Animated.timing(slideAnim, {
            toValue: 0,
            duration: 300,
            useNativeDriver: USE_NATIVE_DRIVER,
          }),
          Animated.timing(fadeAnim, {
            toValue: 1,
            duration: 300,
            useNativeDriver: USE_NATIVE_DRIVER,
          }),
        ]).start();
      } else {
        Animated.parallel([
          Animated.timing(slideAnim, {
            toValue: side === "right" ? screenWidth : -screenWidth,
            duration: 250,
            useNativeDriver: USE_NATIVE_DRIVER,
          }),
          Animated.timing(fadeAnim, {
            toValue: 0,
            duration: 250,
            useNativeDriver: USE_NATIVE_DRIVER,
          }),
        ]).start();
      }
    }
  }, [open, isLargeScreen, screenWidth, side]);

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

  // Mobile: Render as modal with slide animation
  return (
    <Modal
      visible={open}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={StyleSheet.absoluteFill}>
        {/* Backdrop */}
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: colors.overlay,
              opacity: fadeAnim,
            },
          ]}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>

        {/* Panel */}
        <Animated.View
          style={[
            styles.mobilePanel,
            side === "left" ? { left: 0 } : { right: 0 },
            {
              width: screenWidth,
              transform: [{ translateX: slideAnim }],
            },
          ]}
        >
          <View
            className={cn(
              "flex-1 bg-background",
              side === "right" ? "border-l border-border" : "border-r border-border",
              className
            )}
            style={{ paddingTop: insets.top }}
          >
            {children}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  mobilePanel: {
    position: "absolute",
    top: 0,
    bottom: 0,
  },
});
