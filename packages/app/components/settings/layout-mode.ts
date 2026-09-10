import { createContext, useContext } from "react";

/**
 * Whether Settings shows its category column beside the open section, or one
 * pane at a time with a route back to the menu.
 *
 * Decided from the width the settings SCENE has, never from the window. At
 * 768×1024 the window is `md`, but the permanent drawer keeps 255px of it, and
 * a column that switched on the window width sat beside a 273px preferences
 * pane: "Alia's Response Language" elided to "Alia's …" and every description
 * was cut (#548). `settings/_layout.tsx` measures the scene and hands the
 * answer down through `SettingsLayoutContext`; the index redirect, the column
 * and the header's back control all read it from there.
 */
export type SettingsLayoutMode = "split" | "stacked";

/** Category column in split mode (Tailwind `w-56`)… */
export const SETTINGS_COLUMN_WIDTH = 224;
/** …and the wider one (`w-72`) once the scene is desktop-sized. */
export const SETTINGS_WIDE_COLUMN_WIDTH = 288;
/** Scene width from which the column takes its wider size — Tailwind's `lg`. */
export const SETTINGS_WIDE_COLUMN_MIN_WIDTH = 1024;
/** The `md:gap-2` between the two panes. */
export const SETTINGS_PANE_GAP = 8;
/**
 * The narrowest section pane worth putting a column beside.
 *
 * A preference row (`SettingsListItem`) spends 136px on chrome — 24 of row
 * padding, the 20px icon, three 12px gaps, the 16px chevron and the pane's own
 * `p-5` — and gives the rest to a title and a current value that it elides
 * rather than wraps. The longest pair, "Alia's Response Language" beside
 * "Select a language", wants about 350px of it. 488 keeps every row whole with
 * room for the chevron; below it the column costs the section more than the
 * column is worth, and the menu becomes a screen of its own instead.
 */
export const SETTINGS_DETAIL_MIN_WIDTH = 488;
/** Scene width from which the two panes fit side by side (720). */
export const SETTINGS_SPLIT_MIN_WIDTH =
  SETTINGS_COLUMN_WIDTH + SETTINGS_PANE_GAP + SETTINGS_DETAIL_MIN_WIDTH;

/** The mode for a scene this wide. Pure, so the breakpoint can be tested as a table. */
export function settingsLayoutMode(availableWidth: number): SettingsLayoutMode {
  return availableWidth >= SETTINGS_SPLIT_MIN_WIDTH ? "split" : "stacked";
}

/** Width of the category column for a scene this wide; 0 when there is none. */
export function settingsColumnWidth(availableWidth: number): number {
  if (settingsLayoutMode(availableWidth) === "stacked") return 0;
  return availableWidth >= SETTINGS_WIDE_COLUMN_MIN_WIDTH
    ? SETTINGS_WIDE_COLUMN_WIDTH
    : SETTINGS_COLUMN_WIDTH;
}

/**
 * The measured mode, or `null` while the scene has not reported a width yet.
 * Nothing reading `null` should commit to either mode on a guess: the index
 * would redirect a phone away from the menu it asked for, and a back control
 * would appear only to vanish a frame later. The default is `stacked` because
 * a header rendered outside the settings layout has no column beside it.
 */
export const SettingsLayoutContext = createContext<SettingsLayoutMode | null>("stacked");

export function useSettingsLayoutMode(): SettingsLayoutMode | null {
  return useContext(SettingsLayoutContext);
}
