import React from "react";
import { Platform, View } from "react-native";
import { Text } from "@/components/ui/text";
import { useTranslation } from "@/lib/hooks/use-translation";
import { dragCarriesFiles, nextDragDepth } from "@/lib/chat/attachment-intake";
import { COMPOSER_RADIUS } from "./context";

/**
 * Dropping files onto the composer, on web, where such a gesture exists.
 *
 * Alia had no drag-and-drop at all — no `onDrop`, no `dataTransfer`, nothing —
 * which on web means the browser's own default ran instead: dropping a file
 * anywhere on the page NAVIGATED THE TAB TO IT, losing the draft, the
 * conversation scroll position and any stream in flight. So the first thing
 * this does is not "accept files"; it is `preventDefault`, and it happens even
 * when the composer is closed, because the least a locked composer owes a
 * dropped file is not to throw the page away over it.
 *
 * ## Why the listeners are attached by hand
 *
 * `View` has no `onDragEnter`. react-native-web forwards a fixed set of
 * handlers and the drag family is not in it, and NativeWind's wrapper means a
 * ref here does not resolve to the DOM node either — the fullscreen grow in
 * `prompt-input.tsx` ran into the same wall and solved it the same way, by
 * giving the bar an `id` and looking it up. This hook takes that id.
 */
export interface ComposerDropTargetOptions {
  /** The DOM id of the element the drop lands on — the composer bar itself. */
  elementId: string;
  /** False while the composer is closed or a turn is streaming. */
  enabled: boolean;
  onFiles: (files: File[]) => void;
  /**
   * Changing this re-attaches the listeners. Fullscreen re-parents the bar
   * through a portal, which destroys the node the listeners were on; without a
   * rebind the composer silently stops taking drops the first time it is
   * expanded.
   */
  rebindKey?: string | number;
}

/** Whether a file drag is currently over the composer. */
export function useComposerDropTarget({
  elementId,
  enabled,
  onFiles,
  rebindKey,
}: ComposerDropTargetOptions): boolean {
  const [isOver, setIsOver] = React.useState(false);

  /**
   * How many of the bar's elements the pointer is inside.
   *
   * A ref, and read in the same tick it is written: `dragenter` on a child
   * arrives immediately before `dragleave` on its parent, so the two have to
   * be counted against each other synchronously. State would be one render
   * stale for the pair that matters, which is every pair.
   */
  const depth = React.useRef(0);

  // Held in a ref so the effect does not re-attach — and re-attaching matters:
  // a listener swapped out mid-drag loses the depth count with it, and the
  // overlay never clears.
  const latest = React.useRef({ enabled, onFiles });
  latest.current = { enabled, onFiles };

  React.useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const element = document.getElementById(elementId);
    if (element === null) return;

    const step = (kind: "enter" | "leave" | "drop") => {
      depth.current = nextDragDepth(depth.current, kind);
      setIsOver(depth.current > 0);
    };

    const onDragEnter = (event: globalThis.DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer?.types)) return;
      event.preventDefault();
      step("enter");
    };

    const onDragOver = (event: globalThis.DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer?.types)) return;
      // Both halves are required. Without `preventDefault` on dragOVER
      // specifically — not just on enter — the element is not a drop target at
      // all and `drop` never fires, which is the single most common way a
      // hand-written drop zone appears to work and then does nothing.
      event.preventDefault();
      if (event.dataTransfer !== null)
        event.dataTransfer.dropEffect = latest.current.enabled ? "copy" : "none";
    };

    const onDragLeave = (event: globalThis.DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer?.types)) return;
      step("leave");
    };

    const onDrop = (event: globalThis.DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer?.types)) return;
      event.preventDefault();
      // Reset rather than decrement: no `dragleave` follows a drop, so a
      // decrement leaves the count at one and the overlay stuck over the bar.
      step("drop");
      if (!latest.current.enabled) return;
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) latest.current.onFiles(files);
    };

    element.addEventListener("dragenter", onDragEnter);
    element.addEventListener("dragover", onDragOver);
    element.addEventListener("dragleave", onDragLeave);
    element.addEventListener("drop", onDrop);
    return () => {
      element.removeEventListener("dragenter", onDragEnter);
      element.removeEventListener("dragover", onDragOver);
      element.removeEventListener("dragleave", onDragLeave);
      element.removeEventListener("drop", onDrop);
      // A drag that was over the bar when it was torn down would otherwise
      // leave the count — and the overlay — set for the next mount.
      depth.current = 0;
      setIsOver(false);
    };
  }, [elementId, rebindKey]);

  return isOver;
}

/**
 * What a file drag looks like over the composer.
 *
 * `pointerEvents="none"` is load-bearing rather than tidy: an overlay that
 * takes pointer events is an element the drag ENTERS, so it would fire its own
 * `dragenter`/`dragleave` pair against the same counter it is drawn from, and
 * the affordance would oscillate against itself.
 *
 * It is announced as well as drawn. A drop target that exists only as a
 * dashed outline is a target only for the people who can see it, and while a
 * drag is not a gesture a screen-reader user performs, the composer is shared
 * with people who do both.
 */
export function PromptInputDropOverlay({
  visible,
  enabled,
}: {
  visible: boolean;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  if (!visible) return null;
  return (
    <View
      pointerEvents="none"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      className="absolute inset-0 z-20 items-center justify-center border-2 border-dashed border-primary bg-background/90"
      // Derived from the bar's own corner rather than a class, for the same
      // reason the tiles are: the radius is a number in one place.
      style={{ borderRadius: COMPOSER_RADIUS }}
    >
      <Text className="text-sm font-medium text-foreground">
        {t(enabled ? "composer.dropHint" : "composer.dropUnavailable")}
      </Text>
    </View>
  );
}
