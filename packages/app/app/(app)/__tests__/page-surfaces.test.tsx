import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every top-level page stands on the layout's surface, and the layout owns its opener and title.
 *
 * A page that drew its own `DrawerToggle`, title or surface would show a second opener next to the
 * layout's (#532). These read the sources, so they pin the shape without rendering the pages.
 */

describe('the same opener on every top-level page', () => {
  const page = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../${name}.tsx`, import.meta.url)), 'utf8');

  /**
   * Skills stands on the layout's `AiChatContainer`, whose mobile header owns
   * the menu button and whose crumb owns the title. A second opener, or a
   * second title, on the page itself is the duplicate this guards against.
   */
  it('the skills settings page leaves the opener and the title to the layout', () => {
    const source = page('settings/skills');
    expect(source).not.toMatch(/drawer-toggle/);
    expect(source).not.toContain('<DrawerToggle');
  });

  for (const name of ['shows']) {
    it(`${name}.tsx leaves the opener, the title and the surface to the layout`, () => {
      const source = page(name);
      expect(source).not.toMatch(/drawer-toggle/);
      expect(source).not.toContain('<DrawerToggle');
      expect(source).not.toContain('ContentPanel');
      // Layout classes (rows, gaps, padding) are the page's; a page FRAME —
      // a background, a border or rounded corners — is the layout's alone.
      expect(source).not.toMatch(/surfaceClassName/);
      expect(source).not.toMatch(/className="[^"]*\b(bg-|border|rounded)/);
    });
  }

  /**
   * The other half of the pages above: the layout really does give every
   * non-chat route the opener. `screenLayout` wraps it in `AiChatContainer`
   * with `ShellPageHeader` (Bloom's `PageHeader` carrying the phone's menu
   * button) as its header, and only the chat routes (which compose their own
   * container) are let through bare.
   */
  it('wraps every non-chat route in the container whose header has the opener', () => {
    const layout = page('_layout');
    expect(layout).toContain('screenLayout={screenLayout}');
    expect(layout).toMatch(/<AiChatContainer[\s\S]*header=\{\s*<ShellPageHeader/);
    expect(layout).toMatch(/shows: 'sidebar\.shows'/);
  });

  it('notifications.tsx already has its own way out (a back control)', () => {
    expect(page('notifications')).toContain('router.back()');
  });

  /**
   * A closed drawer stays mounted offscreen (#532). `AiChatShell` takes it out
   * of the accessibility tree and the tab order itself (`inert` on web, Bloom
   * 4.14.1), so the layout hands both sidebars over as they are.
   */
  it('hands both sidebars straight to the shell', () => {
    const layout = page('_layout');
    expect(layout).toContain('sidebar={sidebar}');
    expect(layout).toContain('mobileSidebar={mobileSidebar}');
    expect(layout).toMatch(/<Sidebar mobile \/>/);
  });
});
