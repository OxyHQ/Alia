import React from "react";
import { View, Pressable, Platform } from "react-native";
import { Portal } from "@oxy.so/bloom/portal";
import { SidebarItem } from "@oxy.so/bloom/sidebar";
import { Text } from "@/components/ui/text";
import { ChevronDownIcon } from "@/components/ui/icons/chevron-down-icon";
import { ChevronRightIcon } from "@/components/ui/icons/chevron-right-icon";
import { PlusIcon } from "@/components/ui/icons/plus-icon";
import { bloomIcon } from "@/components/sidebar/bloom-icon";
import { useAppNav } from "@/components/app-shell/nav-context";
import { useColorScheme } from "@/lib/useColorScheme";
import { useUIStore } from "@/lib/stores/ui-store";
import type { IconComponent } from "@/lib/types/icon";

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
 * Desktop icon-rail collapse state shared by every sidebar variant.
 *
 * The two halves of "make the sidebar go away" are still two different things
 * and still decided by the width, but neither of them is the router's any more.
 * In flow (from `lg` up) the column narrows to the 56px rail and `sidebarOpen`
 * is what says so — `app/(app)/_layout.tsx` hands the same flag to
 * `AiChatShell` as `sidebarCollapsed`. Below it there is no rail to narrow to,
 * because the nav is a drawer, so collapsing IS closing and the shell owns that.
 *
 * This used to call `navigation.closeDrawer()` on a `DrawerNavigationProp`,
 * which stopped existing the moment the expo-router `Drawer` did.
 */
export function useSidebarCollapse() {
  const nav = useAppNav();
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);

  const collapsed = nav.inFlow && !sidebarOpen;

  const collapse = React.useCallback(() => {
    if (nav.inFlow) {
      setSidebarOpen(false);
    } else {
      nav.close();
    }
  }, [nav, setSidebarOpen]);

  const expand = React.useCallback(() => {
    setSidebarOpen(true);
  }, [setSidebarOpen]);

  return { collapsed, collapse, expand };
}

export interface SidebarRowProps {
  icon: IconComponent;
  label: string;
  onPress: () => void;
  /** Compact variant for nested rows (e.g. the expanded Agents children). */
  sub?: boolean;
  /** Icon-rail variant used when the sidebar is collapsed. */
  iconOnly?: boolean;
  /** Persistent selected state (e.g. the active settings section). */
  active?: boolean;
}

/**
 * Ghost menu row shared by every sidebar navigation entry — Bloom's
 * `SidebarItem`, with Alia's rail tooltip around it.
 *
 * ## What Bloom draws now
 *
 * The row itself: the pill, the hover, the focus ring, the selected state, the
 * `title` on a collapsed row, the `aria-current` on a selected one, and the
 * label sliding into its collapse slot while the glyph stays pinned. The
 * geometry lines up with what Alia drew by hand — Bloom's `medium` metrics are
 * a 20px glyph in an 8px inset, which is a 36px row, which is the `h-9` this
 * used to be, with the same 8px gap — so the rail's 36px square and the
 * expanded row's height are unchanged. The two measurable differences are the
 * glyph (20 rather than 18) and the label's colour, which is now Bloom's
 * `text-secondary` rather than `text-foreground`. Both are Bloom's opinion
 * about what a sidebar row looks like, which is the opinion being adopted.
 *
 * `sub` maps to `size="small"`: a 30px row with an 18px glyph and a 13px label,
 * against the 32/16/12 it was. One rung down the size axis, rather than a
 * bespoke set of numbers per nesting depth.
 *
 * ## What is still Alia's, and why
 *
 * The tooltip. Bloom's collapsed row sets the DOM `title` attribute, which is a
 * browser tooltip: it appears after the browser's own delay, in the browser's
 * own chrome, near the pointer rather than beside the rail, and on native it is
 * nothing at all. Alia's is a portalled bubble in the app's own surface, pinned
 * to the right of the row, and it is what the rail's other controls (New Chat,
 * the expand button) already use — two kinds of tooltip in one 56px column
 * would read as a mistake. So the row is wrapped in a `View` that carries the
 * measure ref and the pointer enter/leave; `useRailTooltip` is web-only by its
 * own first line, so pointer events are the whole of what it needs.
 *
 * Two props go with this change, both of which nothing passed. `leading` was a
 * node drawn instead of the glyph, for a row whose mark carries its own colour —
 * an agent's; no call site ever used it, because `AgentRow` says in its own
 * comment why an agent is not a one-line row, and `SidebarItemProps` takes an
 * icon COMPONENT with no node slot beside it. `accessibilityLabel` was a name
 * that could differ from the visible label; Bloom's row names itself by its
 * `label` and offers no second string, and a row whose spoken name disagrees
 * with its written one is a thing to argue for case by case rather than to keep
 * a general slot for.
 */
export function SidebarRow({
  icon,
  label,
  onPress,
  sub = false,
  iconOnly = false,
  active = false,
}: SidebarRowProps) {
  const { anchorProps, tooltip } = useRailTooltip(label);
  const item = (
    <SidebarItem
      icon={bloomIcon(icon)}
      label={label}
      size={sub ? "small" : "medium"}
      collapsed={iconOnly}
      selected={active}
      onPress={onPress}
    />
  );

  // Expanded rows have their label on screen; only the rail needs a name for
  // the glyph, so only the rail pays for a measured wrapper.
  if (!iconOnly) return item;

  return (
    <>
      <View
        ref={anchorProps.ref}
        onPointerEnter={anchorProps.onHoverIn}
        onPointerLeave={anchorProps.onHoverOut}
      >
        {item}
      </View>
      {tooltip}
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

/**
 * Collapsible group header (label + chevron) with a trailing add action.
 *
 * Alia's, still. Bloom's nearest thing is `SidebarTree`'s section label, which
 * is a `Text` above a list of `SidebarFolder`s with no toggle of its own and no
 * trailing slot — there is no "+ new project" to hang on it, and no way to
 * collapse the section as a whole.
 */
export function SectionHeader({
  label,
  collapsed,
  onToggle,
  onAdd,
  addAccessibilityLabel,
}: SectionHeaderProps) {
  const { colors } = useColorScheme();
  const Chevron = collapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    <View className="flex-row items-center justify-between pt-4 pb-1 px-2">
      <Pressable
        onPress={onToggle}
        className="flex-row items-center gap-1 flex-1 rounded-lg active:opacity-70"
      >
        <Text className="text-xs font-semibold text-foreground select-none">{label}</Text>
        <Chevron size={12} color={colors.foreground} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={addAccessibilityLabel}
        onPress={onAdd}
        className="h-6 w-6 items-center justify-center rounded-lg hover:bg-muted active:bg-muted"
      >
        <PlusIcon size={14} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

export interface GhostIconButtonProps {
  icon: IconComponent;
  label: string;
  onPress: () => void;
  badge?: boolean;
  /** Rail tooltip anchor from `useRailTooltip` (hover + measure target). */
  anchorProps?: RailTooltipHandle["anchorProps"];
}

/**
 * Square ghost icon button (header collapse trigger, footer action bar).
 *
 * Alia's, still. It is a 32px square with an unread DOT — not a count — and
 * Bloom's sidebar has no icon-button part at all: `SidebarItem` is a full-width
 * pill with a label slot, and its `badge` is a node on the right of that label,
 * which is not a thing that exists on a 32px square.
 */
export function GhostIconButton({
  icon: Icon,
  label,
  onPress,
  badge = false,
  anchorProps,
}: GhostIconButtonProps) {
  const { colors } = useColorScheme();
  return (
    <Pressable
      {...anchorProps}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="h-8 w-8 items-center justify-center rounded-xl hover:bg-muted active:bg-muted"
    >
      <Icon size={18} color={colors.mutedForeground} />
      {badge && (
        <View className="absolute top-0.5 right-0.5 h-2.5 w-2.5 rounded-full bg-red-500 border border-background" />
      )}
    </Pressable>
  );
}
