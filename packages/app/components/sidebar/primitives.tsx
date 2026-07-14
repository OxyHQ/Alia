import React from "react";
import { View, Pressable, Platform } from "react-native";
import { Plus, ChevronDown, ChevronRight, type LucideIcon } from "lucide-react-native";
import { Portal } from "@oxyhq/bloom/portal";
import { useNavigation } from "expo-router";
import type { DrawerNavigationProp } from "expo-router/drawer";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useIsLargeScreen } from "@/hooks/useIsLargeScreen";
import { useUIStore } from "@/lib/stores/ui-store";

export interface RailTooltipHandle {
  anchorProps: {
    ref: React.RefObject<View | null>;
    onHoverIn: () => void;
    onHoverOut: () => void;
  };
  tooltip: React.ReactNode;
}

/**
 * Hover tooltip for icon-rail items. Attach `anchorProps` to the row's own
 * Pressable and render `tooltip` next to it; the bubble goes through the Bloom
 * portal so the drawer can't clip it. Hover-only, so touch never shows it.
 */
export function useRailTooltip(label: string): RailTooltipHandle {
  const ref = React.useRef<View>(null);
  const [anchor, setAnchor] = React.useState<{ x: number; y: number } | null>(null);

  const onHoverIn = React.useCallback(() => {
    if (Platform.OS !== "web") return;
    ref.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x: x + width + 10, y: y + height / 2 });
    });
  }, []);
  const onHoverOut = React.useCallback(() => setAnchor(null), []);

  const tooltip = anchor ? (
    <Portal>
      <View
        pointerEvents="none"
        className="absolute rounded-lg bg-popover border border-border px-2 py-1 shadow-sm"
        style={{ left: anchor.x, top: anchor.y - 13 }}
      >
        <Text className="text-xs text-popover-foreground" numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Portal>
  ) : null;

  return { anchorProps: { ref, onHoverIn, onHoverOut }, tooltip };
}

/**
 * Desktop icon-rail collapse state shared by every sidebar variant. The drawer
 * width itself is driven from `(app)/_layout.tsx` off the same store flag.
 */
export function useSidebarCollapse() {
  const isLargeScreen = useIsLargeScreen();
  const drawerNavigation = useNavigation<DrawerNavigationProp<ReactNavigation.RootParamList>>();
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);

  const collapsed = isLargeScreen && !sidebarOpen;

  const collapse = React.useCallback(() => {
    // Desktop: the permanent drawer collapses to an icon rail; mobile: the
    // front drawer simply closes.
    if (isLargeScreen) {
      setSidebarOpen(false);
    } else {
      drawerNavigation.closeDrawer();
    }
  }, [isLargeScreen, setSidebarOpen, drawerNavigation]);

  const expand = React.useCallback(() => {
    setSidebarOpen(true);
  }, [setSidebarOpen]);

  return { collapsed, collapse, expand };
}

export interface SidebarRowProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
  /** Compact variant for nested rows (e.g. the expanded Agents children). */
  sub?: boolean;
  /** Icon-rail variant used when the sidebar is collapsed. */
  iconOnly?: boolean;
  /** Persistent selected state (e.g. the active settings section). */
  active?: boolean;
}

/** Ghost menu row shared by every sidebar navigation entry. */
export function SidebarRow({
  icon: Icon,
  label,
  onPress,
  accessibilityLabel,
  sub = false,
  iconOnly = false,
  active = false,
}: SidebarRowProps) {
  const { anchorProps, tooltip } = useRailTooltip(label);
  return (
    <>
      <Pressable
        {...(iconOnly ? anchorProps : null)}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        onPress={onPress}
        className={cn(
          "flex-row items-center rounded-xl hover:bg-muted active:bg-muted",
          iconOnly ? "h-9 w-9 justify-center" : "gap-2 px-1.5 w-full",
          !iconOnly && (sub ? "h-8" : "h-9"),
          active && "bg-muted"
        )}
      >
        <Icon size={sub ? 16 : 18} className="text-foreground" />
        {!iconOnly && (
          <Text
            className={cn(
              "text-foreground",
              sub ? "text-xs" : "text-sm",
              active && "font-medium"
            )}
          >
            {label}
          </Text>
        )}
      </Pressable>
      {iconOnly && tooltip}
    </>
  );
}

export interface SectionHeaderProps {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  onAdd: () => void;
  addAccessibilityLabel: string;
}

/** Collapsible group header (label + chevron) with a trailing add action. */
export function SectionHeader({
  label,
  collapsed,
  onToggle,
  onAdd,
  addAccessibilityLabel,
}: SectionHeaderProps) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <View className="flex-row items-center justify-between pt-4 pb-1 px-2">
      <Pressable
        onPress={onToggle}
        className="flex-row items-center gap-1 flex-1 rounded-lg active:opacity-70"
      >
        <Text className="text-xs font-semibold text-foreground select-none">{label}</Text>
        <Chevron size={12} className="text-foreground" />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={addAccessibilityLabel}
        onPress={onAdd}
        className="h-6 w-6 items-center justify-center rounded-lg hover:bg-muted active:bg-muted"
      >
        <Plus size={14} className="text-muted-foreground" />
      </Pressable>
    </View>
  );
}

export interface GhostIconButtonProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  badge?: boolean;
  /** Rail tooltip anchor from `useRailTooltip` (hover + measure target). */
  anchorProps?: RailTooltipHandle["anchorProps"];
}

/** Square ghost icon button (header collapse trigger, footer action bar). */
export function GhostIconButton({
  icon: Icon,
  label,
  onPress,
  badge = false,
  anchorProps,
}: GhostIconButtonProps) {
  return (
    <Pressable
      {...anchorProps}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="h-9 w-9 items-center justify-center rounded-xl hover:bg-muted active:bg-muted"
    >
      <Icon size={18} className="text-muted-foreground" />
      {badge && (
        <View className="absolute top-0.5 right-0.5 h-2.5 w-2.5 rounded-full bg-red-500 border border-background" />
      )}
    </Pressable>
  );
}
