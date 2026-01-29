import { View, Modal, Pressable, Animated, useWindowDimensions, StyleSheet } from "react-native";
import { useUIStore } from "@/lib/stores/ui-store";
import { CreditsPanel } from "./credits-panel";
import * as React from "react";

const PANEL_WIDTH = 320;

export function RightPanel() {
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 768;
  const rightPanel = useUIStore((state) => state.rightPanel);
  const setRightPanel = useUIStore((state) => state.setRightPanel);

  const isOpen = rightPanel !== null;

  // Animation values for mobile sheet
  const slideAnim = React.useRef(new Animated.Value(width)).current;
  const fadeAnim = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (!isLargeScreen) {
      if (isOpen) {
        Animated.parallel([
          Animated.timing(slideAnim, {
            toValue: 0,
            duration: 300,
            useNativeDriver: true,
          }),
          Animated.timing(fadeAnim, {
            toValue: 1,
            duration: 300,
            useNativeDriver: true,
          }),
        ]).start();
      } else {
        Animated.parallel([
          Animated.timing(slideAnim, {
            toValue: width,
            duration: 250,
            useNativeDriver: true,
          }),
          Animated.timing(fadeAnim, {
            toValue: 0,
            duration: 250,
            useNativeDriver: true,
          }),
        ]).start();
      }
    }
  }, [isOpen, isLargeScreen, width]);

  const renderPanelContent = () => {
    switch (rightPanel) {
      case "credits":
        return <CreditsPanel />;
      default:
        return null;
    }
  };

  // Desktop: Render as part of flex layout
  if (isLargeScreen) {
    if (!isOpen) return null;

    return (
      <View style={{ width: PANEL_WIDTH }} className="bg-background">
        {renderPanelContent()}
      </View>
    );
  }

  // Mobile: Render as modal sheet
  return (
    <Modal
      visible={isOpen}
      transparent
      animationType="none"
      onRequestClose={() => setRightPanel(null)}
      statusBarTranslucent
    >
      <View style={StyleSheet.absoluteFill}>
        {/* Backdrop */}
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: "rgba(0, 0, 0, 0.5)",
              opacity: fadeAnim,
            },
          ]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setRightPanel(null)}
          />
        </Animated.View>

        {/* Panel */}
        <Animated.View
          style={[
            styles.mobilePanel,
            {
              width: width,
              transform: [{ translateX: slideAnim }],
            },
          ]}
        >
          <View className="flex-1 bg-background">
            {renderPanelContent()}
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
    right: 0,
  },
});
