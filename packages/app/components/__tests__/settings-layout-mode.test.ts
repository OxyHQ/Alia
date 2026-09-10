import { describe, expect, it } from 'vitest';
import {
  SETTINGS_COLUMN_WIDTH,
  SETTINGS_SPLIT_MIN_WIDTH,
  SETTINGS_WIDE_COLUMN_MIN_WIDTH,
  SETTINGS_WIDE_COLUMN_WIDTH,
  settingsColumnWidth,
  settingsLayoutMode,
  type SettingsLayoutMode,
} from '../settings/layout-mode';

/**
 * When Settings gets a column beside the section, and when it gets a menu.
 *
 * At 768×1024 with the drawer open there were three columns — the drawer, the
 * category column and a 273px preferences pane — and the pane elided "Alia's
 * Response Language" to "Alia's …" (#548). The split is now decided on the
 * width the settings scene actually has, so this is a table of viewports, the
 * scene each leaves, and the mode that follows; the drawer widths are the ones
 * `app/(app)/_layout.tsx` sets (255 open, 56 as a rail, an 8px gutter to the
 * right of the scene at `md`), and below `md` the drawer is an overlay and the
 * scene is the whole window.
 */

const MD = 768;
const DRAWER_OPEN = 255;
const DRAWER_RAIL = 56;
const GUTTER = 8;

type Drawer = 'open' | 'rail';

function sceneWidth(viewport: number, drawer: Drawer): number {
  if (viewport < MD) return viewport;
  return viewport - (drawer === 'open' ? DRAWER_OPEN : DRAWER_RAIL) - GUTTER;
}

describe('settingsLayoutMode', () => {
  const table: Array<[viewport: number, drawer: Drawer, mode: SettingsLayoutMode]> = [
    // The drawer is an overlay here, so the category column is the ONE rail on screen.
    [767, 'open', 'split'],
    // The widths from the report: a permanent 255px drawer beside the scene.
    [768, 'open', 'stacked'],
    [820, 'open', 'stacked'],
    [1024, 'open', 'split'],
    [1440, 'open', 'split'],
    // Collapsing the drawer to its rail hands the scene 199px more.
    [768, 'rail', 'stacked'],
    [820, 'rail', 'split'],
    [1024, 'rail', 'split'],
  ];

  for (const [viewport, drawer, mode] of table) {
    it(`${viewport}px with the drawer ${drawer} is ${mode}`, () => {
      expect(settingsLayoutMode(sceneWidth(viewport, drawer))).toBe(mode);
    });
  }

  it('flips exactly at the threshold, and the threshold is the two panes side by side', () => {
    expect(settingsLayoutMode(SETTINGS_SPLIT_MIN_WIDTH - 1)).toBe('stacked');
    expect(settingsLayoutMode(SETTINGS_SPLIT_MIN_WIDTH)).toBe('split');
    // The column, the gap and the narrowest pane that keeps a preference row
    // whole — not a window breakpoint, which is what got the pane down to 273px.
    expect(SETTINGS_SPLIT_MIN_WIDTH).toBe(720);
  });
});

describe('settingsColumnWidth', () => {
  it('is nothing when stacked', () => {
    expect(settingsColumnWidth(SETTINGS_SPLIT_MIN_WIDTH - 1)).toBe(0);
    expect(settingsColumnWidth(sceneWidth(768, 'open'))).toBe(0);
  });

  it('is the narrow column from the split up, and the wide one from desktop widths', () => {
    expect(settingsColumnWidth(SETTINGS_SPLIT_MIN_WIDTH)).toBe(SETTINGS_COLUMN_WIDTH);
    // 1024 with the drawer open leaves 761: still the narrow column, which is
    // what leaves the pane wide enough to read.
    expect(settingsColumnWidth(sceneWidth(1024, 'open'))).toBe(SETTINGS_COLUMN_WIDTH);
    expect(settingsColumnWidth(SETTINGS_WIDE_COLUMN_MIN_WIDTH - 1)).toBe(SETTINGS_COLUMN_WIDTH);
    expect(settingsColumnWidth(SETTINGS_WIDE_COLUMN_MIN_WIDTH)).toBe(SETTINGS_WIDE_COLUMN_WIDTH);
    expect(settingsColumnWidth(sceneWidth(1440, 'open'))).toBe(SETTINGS_WIDE_COLUMN_WIDTH);
  });
});
