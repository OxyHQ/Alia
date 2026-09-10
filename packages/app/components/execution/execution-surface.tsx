import { useEffect, type ReactNode } from "react";
import { View, Platform, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Dialog } from "@oxy.so/bloom/dialog";
import { cn } from "@/lib/utils";
import { useIsLargeScreen } from "@/lib/hooks/use-is-large-screen";
import { ASIDE_WIDTH, POPOVER_VIEWPORT_BOTTOM_MARGIN, POPOVER_VIEWPORT_MARGIN, RAIL_GUTTER, REF } from "./tokens";

/**
 * The chat header's height, without the safe-area inset it adds on top —
 * `ChatHeader` draws itself `56 + insets.top` tall. The desktop rail hangs
 * below it: `top-full` of the header in the reference wrapper.
 */
const HEADER_HEIGHT = 56;

/** The scene's `md:p-2` gutter above the header on a wide screen. */
const SCENE_GUTTER = 8;

/**
 * The narrowest viewport that carries the rail. Two samples were measured —
 * the rail at 1440 and the popover at 390 — and the switch between them is
 * not inferred from either (#544): it is the app's own `lg` breakpoint, the
 * first at which the thread column (`lib/chat-layout.ts`) keeps its width
 * beside a 332px rail and the sidebar. Below it, down to `md`, the layout
 * still mounts the panel beside the thread, and this surface answers with
 * the popover instead of squeezing the rail in.
 */
const RAIL_MIN_VIEWPORT = 1024;

export interface ExecutionSurfaceProps {
  open: boolean;
  onClose: () => void;
  /** The accessible name of the aside. */
  label: string;
  children: ReactNode;
}

/**
 * The surface the execution panel is presented on.
 *
 * Two variants, both from `files-and-sources.raw.html`:
 *
 *  - **Rail**, at wide desktop: the `absolute end-0 top-full
 *    w-[calc(300px+2rem)] px-4 pb-4` wrapper, persistent below the header,
 *    holding the 300px `rounded-3xl border` aside. It is not a dialog — the
 *    conversation stays interactive beside it — so Escape is handled here on
 *    the web, and focus return is the caller's (`focus-return.ts`).
 *  - **Popover**, at phone and tablet widths: the same aside, 300px or the
 *    viewport less 16px, inside the viewport. It is Bloom's centered `Dialog`
 *    so the backdrop, the dismiss gesture, Escape and the focus trap are the
 *    ones every other in-viewport surface in the app has; the panel's own
 *    chrome (radius, border, background) is drawn once, on the aside. The
 *    desktop rail is never forced into the conversation column.
 */
export function ExecutionSurface({ open, onClose, label, children }: ExecutionSurfaceProps) {
  const isLargeScreen = useIsLargeScreen();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const rail = isLargeScreen && width >= RAIL_MIN_VIEWPORT;

  useEffect(() => {
    if (!open || !rail || Platform.OS !== "web") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, rail, onClose]);

  if (rail) {
    if (!open) return null;
    return (
      <View
        style={{ width: ASIDE_WIDTH + RAIL_GUTTER * 2, paddingTop: insets.top + SCENE_GUTTER + HEADER_HEIGHT }}
        className="flex-col px-4 pb-4"
      >
        {/* `flex max-h-full origin-top-right flex-col` */}
        <View className="max-h-full flex-1 flex-col">
          <View
            role="complementary"
            aria-label={label}
            className={cn("relative w-full flex-shrink overflow-hidden rounded-3xl border", REF.border, REF.surface)}
          >
            {children}
          </View>
        </View>
      </View>
    );
  }

  const popoverWidth = Math.min(ASIDE_WIDTH, width - POPOVER_VIEWPORT_MARGIN);
  const popoverMaxHeight = Math.max(200, height - insets.top - HEADER_HEIGHT - POPOVER_VIEWPORT_BOTTOM_MARGIN);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      placement="center"
      maxWidth={popoverWidth}
      contentPadding={0}
      scrollable={false}
      morph={false}
      label={label}
      style={{ padding: 0, borderRadius: 24, backgroundColor: "transparent", overflow: "visible" }}
      panelClassName="rounded-3xl"
    >
      <View
        role="complementary"
        aria-label={label}
        className={cn("relative overflow-hidden rounded-3xl border", REF.border, REF.surface)}
        style={{ width: popoverWidth, maxHeight: popoverMaxHeight }}
      >
        {children}
      </View>
    </Dialog>
  );
}
