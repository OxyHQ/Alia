import { Platform } from "react-native";

// Reused across measurements so we don't allocate a canvas per call.
let measureCanvas: HTMLCanvasElement | undefined;

/**
 * Web-only single-line fit test: is `text`'s rendered width — measured with the
 * canvas 2D `measureText` API in the element's *computed* font (so it honours
 * whatever responsive font-size is actually applied) — greater than the
 * element's inner width minus `reservedPadding`?
 *
 * The element is resolved by DOM id (`document.getElementById`), NOT by an RN
 * ref: under the NativeWind 5 preview / react-native-css className interop the
 * forwarded ref does NOT resolve to the host DOM node (and `onLayout` never
 * fires either), so both paths silently no-op on web. Passing a `nativeID`
 * through to the input and looking it up by id is the deterministic escape
 * hatch. Returns null off-web / before the node mounts / when the 2D context is
 * unavailable, so callers fall back to native onLayout measurement.
 */
export function overflowsSingleLine(
  elementId: string,
  text: string,
  reservedPadding: number,
): boolean | null {
  if (Platform.OS !== "web" || typeof document === "undefined") return null;

  const el = document.getElementById(elementId);
  if (!el) return null;

  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) return null;

  const cs = window.getComputedStyle(el);
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;

  const trackWidth = el.clientWidth - reservedPadding;
  if (trackWidth <= 0) return false;
  return ctx.measureText(text).width > trackWidth;
}
