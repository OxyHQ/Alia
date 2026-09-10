import { Platform } from "react-native";

/**
 * What each reference-site class became in Alia's NativeWind theme.
 *
 * The extracts in the `*.raw.html` files next to this module use two private
 * palettes — ChatGPT's `token-*` classes and Claude's `text-text-*` /
 * `bg-bg-*` / `border-border-*` scale — that resolve to CSS variables only
 * those sites define. Every one of them is mapped HERE, by name, to a token
 * `global.css` registers, so the components never carry a class that
 * silently compiles to nothing. Spacing, radius, typography and layout
 * utilities from the extracts are standard Tailwind and are used as they are.
 *
 * Alia's theme has one muted text colour where the references have two
 * (secondary and tertiary), so both collapse onto it; the hierarchy between
 * them is kept by weight and size rather than by a third colour.
 */
export const REF = {
  /** `text-token-text-primary`, Claude `text-secondary` (its hover/primary label colour — NOT Alia's accent). */
  textPrimary: "text-foreground",
  /** `text-token-text-secondary` — section titles. */
  textSecondary: "text-muted-foreground",
  /** `text-token-text-tertiary`, Claude `text-muted` / `text-text-500` — the summary label, carets, step titles. */
  textTertiary: "text-muted-foreground",
  /** `hover:text-token-text-primary` — the summary label under the pointer. */
  hoverTextPrimary: "hover:text-foreground",
  /** `border-token-border-light`, Claude `border-border-300` / `bg-border-300` (the timeline hairline). */
  border: "border-border",
  /** The same hairline as a filled 1px view. */
  borderFill: "bg-border",
  /** `bg-token-bg-primary`, Claude `bg-bg-000` — the aside and the expanded block. */
  surface: "bg-background",
  /** Claude `bg-surface-1` — the two code blocks inside the expanded block. */
  codeSurface: "bg-muted",
  /** `hover:bg-token-text-primary/3` / `dark:hover:bg-white/6`, Claude `hover:bg-fill-ghost-hover` — a row under the pointer or finger. */
  rowHover: "hover:bg-muted active:bg-muted",
  /** `shadow-elevation-01` — the popover itself is `shadow-none!` in the extract, so the aside carries no shadow either. */
  elevation: "",
} as const;

/**
 * `font-family: var(--font-mono)` in the extract. React Native's `fontFamily`
 * takes ONE family, not a CSS stack, and the app bundles no mono face, so this
 * is the platform's own — the same choice `app/(biglayout)/codea-subscribe.tsx`
 * makes.
 */
export const MONO_FONT = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

/** The aside's width in both extracts: the 300px popover and the 300px rail. */
export const ASIDE_WIDTH = 300;

/** `px-4` on the desktop wrapper (`w-[calc(300px+2rem)]`): 16px either side. */
export const RAIL_GUTTER = 16;

/** `w-[min(300px,calc(100vw-1rem))]`: 8px of viewport either side of the popover. */
export const POPOVER_VIEWPORT_MARGIN = 16;

/**
 * `max-h-[calc(100svh-var(--header-height,3.5rem)-2rem)]`: the scroll area
 * stops 2rem short of the viewport below the header.
 */
export const POPOVER_VIEWPORT_BOTTOM_MARGIN = 32;
