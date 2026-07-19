import type { ReactNode } from "react";
import { ContentPanel } from "@oxyhq/bloom/content-panel";

interface ScreenShellProps {
  children: ReactNode;
}

/**
 * The app content shell: frames every routed drawer scene in Bloom's
 * `ContentPanel` so Alia's content gets the shared Oxy app-shell surface —
 * full-bleed below `md`, a rounded/bordered panel (with the web sticky
 * bleed-mask + one continuous border frame) at `md`+.
 *
 * `framed` is intentionally omitted to use `ContentPanel`'s responsive default:
 * pure NativeWind `md:` gating, so the breakpoint is decided in CSS with no JS
 * media-query hook. The surface is painted `bg-background` to match every Alia
 * screen's own `flex-1 bg-background` root, so the frame reads as a clean rounded
 * border on the same surface — no card/background color seam at the rounded
 * corners.
 *
 * Alia screens own their full-height layout and internal scrolling (chat's
 * `ChatInterface`, settings' `ScrollView`), and web body scroll is disabled
 * (`ScrollViewStyleReset`), so — unlike a document-scroll app — this shell adds
 * no `ScrollView` of its own; it purely frames the scene the drawer renders.
 */
export function ScreenShell({ children }: ScreenShellProps) {
  return (
    <ContentPanel surfaceClassName="bg-background">{children}</ContentPanel>
  );
}
