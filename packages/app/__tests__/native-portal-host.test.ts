import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT } from '@/shared/testing/app-root';

/**
 * On native, Bloom's `SettingsModal` (and its tooltip and media gallery) draw
 * through `@oxy.so/bloom/portal`: `<Portal>` hands its element to the nearest
 * `<PortalProvider>`, and a `<PortalOutlet>` renders what it was handed. With
 * neither mounted, `<Portal>` talks to the context's default, which drops the
 * element — no error, no warning, nothing on screen. That is how Settings
 * stopped opening on Android: the sidebar's row closed the drawer and nothing
 * came up (found on a Pixel 8a, `docs/native-validation.mdx`). The web does not
 * notice, because there the portal goes straight to the document.
 *
 * The outlet renders in ITS place in the tree, so its context is what the
 * portaled element reads: it has to sit inside `AliaSettingsProvider`, whose
 * pages call `useAliaSettings()`, while the provider has to sit above it,
 * because the settings modal is rendered by `AliaSettingsProvider` itself.
 */

const read = (path: string) =>
  readFileSync(join(APP_ROOT, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe("Bloom's native portal host", () => {
  it('is mounted once, around the settings provider, with the outlet inside it', () => {
    const layout = read('app/(app)/_layout.tsx');
    expect(layout).toMatch(
      /import \{[^}]*\bPortalOutlet\b[^}]*\bPortalProvider\b[^}]*\} from '@oxy\.so\/bloom\/portal'/,
    );

    const provider = layout.indexOf('<PortalProvider>');
    const settings = layout.indexOf('<AliaSettingsProvider>');
    const outlet = layout.indexOf('<PortalOutlet />');
    const settingsEnd = layout.indexOf('</AliaSettingsProvider>');
    const providerEnd = layout.indexOf('</PortalProvider>');

    expect(provider).toBeGreaterThan(-1);
    expect(provider).toBeLessThan(settings);
    expect(outlet).toBeGreaterThan(settings);
    expect(outlet).toBeLessThan(settingsEnd);
    expect(settingsEnd).toBeLessThan(providerEnd);
    expect(layout.match(/<PortalOutlet \/>/g)).toHaveLength(1);
  });

  it('is needed: the installed settings modal renders through that portal on native', () => {
    const require = createRequire(join(APP_ROOT, 'package.json'));
    const bloom = dirname(require.resolve('@oxy.so/bloom/package.json'));
    const nativePortal = readFileSync(join(bloom, 'src/settings-modal/modal-portal.native.tsx'), 'utf8');
    expect(nativePortal).toMatch(/export \{ Portal as ModalPortal \} from '\.\.\/portal'/);
  });
});
