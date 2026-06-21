import * as React from "react";
import {
  Modal,
  View,
  Pressable,
  Animated,
  Platform,
  useWindowDimensions,
  StyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { Text } from "./text";

interface SheetProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

const SheetContext = React.createContext<{
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}>({
  open: false,
});

const Sheet = ({ open, onOpenChange, children }: SheetProps) => {
  return (
    <SheetContext.Provider value={{ open: open ?? false, onOpenChange }}>
      {children}
    </SheetContext.Provider>
  );
};

const SheetTrigger = React.forwardRef<
  React.ElementRef<typeof Pressable>,
  React.ComponentPropsWithoutRef<typeof Pressable>
>(({ onPress, ...props }, ref) => {
  const { onOpenChange } = React.useContext(SheetContext);

  return (
    <Pressable
      ref={ref}
      onPress={(e) => {
        onOpenChange?.(true);
        onPress?.(e);
      }}
      {...props}
    />
  );
});

SheetTrigger.displayName = "SheetTrigger";

interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof View> {
  overlayClassName?: string;
  side?: "left" | "right";
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof View>,
  SheetContentProps
>(({ className, overlayClassName, side = "right", children, ...props }, ref) => {
  const { open, onOpenChange } = React.useContext(SheetContext);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // Responsive: full width (fixed) on mobile, flex on desktop
  const isMobile = width < 640;
  // Animation distance: full width on mobile, 400px on desktop (max-width)
  const slideDistance = isMobile ? width : 400;

  const slideAnim = React.useRef(new Animated.Value(slideDistance)).current;
  const fadeAnim = React.useRef(new Animated.Value(0)).current;

  // Update animation value when slide distance changes (window resize)
  React.useEffect(() => {
    if (!open) {
      slideAnim.setValue(slideDistance);
    }
  }, [slideDistance, open]);

  React.useEffect(() => {
    if (open) {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 300,
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: slideDistance,
          duration: 250,
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 250,
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]).start();
    }
  }, [open, slideDistance]);

  return (
    <Modal
      visible={open}
      transparent
      animationType="none"
      onRequestClose={() => onOpenChange?.(false)}
      statusBarTranslucent
    >
      {/* Full screen container */}
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
            onPress={() => onOpenChange?.(false)}
          />
        </Animated.View>

        {/* Sheet Panel - Animated wrapper */}
        <Animated.View
          style={[
            styles.sheetWrapper,
            isMobile ? { width: width } : { maxWidth: 400 },
            { transform: [{ translateX: slideAnim }] },
          ]}
        >
          {/* Inner View with NativeWind styles */}
          <View
            ref={ref}
            className={cn(
              "flex-1 bg-background",
              !isMobile && "border-l border-border rounded-l-2xl",
              className
            )}
            style={[
              { paddingTop: insets.top },
              !isMobile ? styles.sheetInner : undefined,
            ]}
            {...props}
          >
            {children}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
});

SheetContent.displayName = "SheetContent";

const styles = StyleSheet.create({
  sheetWrapper: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
  },
  sheetInner: {
    boxShadow: '-2px 0px 10px rgba(0, 0, 0, 0.25)',
    elevation: 10,
  },
});

const SheetHeader = React.forwardRef<
  React.ElementRef<typeof View>,
  React.ComponentPropsWithoutRef<typeof View>
>(({ className, children, ...props }, ref) => {
  const { onOpenChange } = React.useContext(SheetContext);

  return (
    <View
      ref={ref}
      className={cn(
        "flex-row items-center justify-between px-4 py-3 border-b border-border",
        className
      )}
      {...props}
    >
      <View className="flex-1">{children}</View>
      <Pressable
        className="p-1 rounded-lg active:opacity-70"
        onPress={() => onOpenChange?.(false)}
      >
        <X size={20} className="text-muted-foreground" />
      </Pressable>
    </View>
  );
});

SheetHeader.displayName = "SheetHeader";

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof Text>,
  React.ComponentPropsWithoutRef<typeof Text>
>(({ className, ...props }, ref) => {
  return (
    <Text
      ref={ref}
      className={cn("text-base font-semibold text-foreground", className)}
      {...props}
    />
  );
});

SheetTitle.displayName = "SheetTitle";

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof Text>,
  React.ComponentPropsWithoutRef<typeof Text>
>(({ className, ...props }, ref) => {
  return (
    <Text
      ref={ref}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
});

SheetDescription.displayName = "SheetDescription";

const SheetFooter = React.forwardRef<
  React.ElementRef<typeof View>,
  React.ComponentPropsWithoutRef<typeof View>
>(({ className, ...props }, ref) => {
  return (
    <View
      ref={ref}
      className={cn("p-4 border-t border-border", className)}
      {...props}
    />
  );
});

SheetFooter.displayName = "SheetFooter";

export {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
};
